/**
 * `@multistageharness/config-discovery` — the public surface.
 *
 * Behavior is defined by `packages/spec/SPEC.md`. This file assembles discovery (discover.ts),
 * loading (loaders.ts), merging (merge.ts), the env layer (env.ts), and validation
 * (validate.ts) into the one function a consumer imports.
 */

import { listConfigFiles, resolveProjectRoots, resolveUserRoot } from './discover.js'
import type { ConfigFileRef } from './discover.js'
import { envLayer } from './env.js'
import { ConfigError, isConfigError } from './errors.js'
import { createExplorer, createExplorerSync, loadConfigFile, loadConfigFileSync } from './loaders.js'
import { applyStrategy, mergeLayers } from './merge.js'
import type { Layer } from './merge.js'
import { buildSources } from './sources.js'
import { validateConfig, validateConfigSync } from './validate.js'
import type { Loaded, LoadOptions, LoadResult, StandardSchemaV1, WarningSink } from './types.js'

export { ConfigError, isConfigError }
export type { ConfigErrorKind } from './errors.js'
export type {
  ArrayMerge,
  Format,
  Loaded,
  LoadOptions,
  Source,
  StandardSchemaV1,
  Strategy,
  WarningSink,
} from './types.js'
export { resolveProjectRoots, resolveUserRoot, listConfigFiles } from './discover.js'
export { envLayer } from './env.js'
export { mergeLayers, applyStrategy, isPlainObject } from './merge.js'
export { buildSources } from './sources.js'

interface Resolved {
  packageName: string
  cwd: string
  home: string | undefined
  env: Record<string, string | undefined>
  envPrefix: string
  strategy: NonNullable<LoadOptions['strategy']>
  arrayMerge: NonNullable<LoadOptions['arrayMerge']>
  onWarning: WarningSink
  defaults: Record<string, unknown>
  overrides: Record<string, unknown>
  options: LoadOptions<StandardSchemaV1 | undefined>
}

/**
 * `cwd` and `env` are the only two places the ambient process is read, and both are
 * overridable. Everything downstream takes them as arguments, which is what makes the probe and
 * the tests hermetic.
 */
function resolveInputs(packageName: string, options: LoadOptions<never> | LoadOptions<StandardSchemaV1>): Resolved {
  // A programming error, not a configuration error: it has no SPEC §5 `kind`, and dressing it
  // up as a ConfigError would put it in the same catch block as a malformed config file.
  if (packageName === '' || /[\\/]/.test(packageName) || packageName === '.' || packageName === '..') {
    throw new TypeError(`package name ${JSON.stringify(packageName)} must be a single path segment`)
  }
  const opts = options as LoadOptions<StandardSchemaV1 | undefined>
  return {
    packageName,
    cwd: opts.cwd ?? process.cwd(),
    home: opts.home,
    env: opts.env ?? process.env,
    envPrefix: (opts.envPrefix ?? packageName.toUpperCase().replace(/[^A-Z0-9]/g, '_')).toUpperCase(),
    strategy: opts.strategy ?? 'layered',
    arrayMerge: opts.arrayMerge ?? 'replace',
    onWarning: opts.onWarning ?? ((message: string) => console.warn(message)),
    defaults: opts.defaults ?? {},
    overrides: opts.overrides ?? {},
    options: opts,
  }
}

interface Plan {
  /** Every config directory to read, lowest precedence first (SPEC §2.7). */
  blocks: { root: string; precedence: 1 | 2; files: ConfigFileRef[] }[]
  resolved: Resolved
}

/** Discovery is synchronous in both flows; only the file reads differ. */
function planLoad(packageName: string, options: LoadOptions<never> | LoadOptions<StandardSchemaV1>): Plan {
  const resolved = resolveInputs(packageName, options)
  const { profile, stopDir } = resolved.options

  const userRoot = resolveUserRoot(packageName, {
    ...(resolved.home === undefined ? {} : { home: resolved.home }),
    env: resolved.env,
    onWarning: resolved.onWarning,
  })
  const projectRoots = resolveProjectRoots(resolved.cwd, packageName, {
    ...(resolved.home === undefined ? {} : { home: resolved.home }),
    ...(stopDir === undefined ? {} : { stopDir }),
  })

  const roots: { root: string; precedence: 1 | 2 }[] = [
    ...(userRoot === null ? [] : [{ root: userRoot, precedence: 1 as const }]),
    ...projectRoots.map((root) => ({ root, precedence: 2 as const })),
  ]
  return {
    resolved,
    blocks: roots.map(({ root, precedence }) => ({
      root,
      precedence,
      files: listConfigFiles(root, profile),
    })),
  }
}

function fileLayer(ref: ConfigFileRef, value: Record<string, unknown>, root: string, precedence: 1 | 2): Layer {
  return {
    value,
    root,
    source: {
      path: ref.path,
      format: ref.format,
      // SPEC §3.1: a `.env` is its own layer, applied inside its root's block.
      precedence: ref.format === 'dotenv' ? 3 : precedence,
      keys: [],
    },
  }
}

function surroundingLayers(resolved: Resolved): { before: Layer[]; after: Layer[] } {
  const before: Layer[] = []
  if (Object.keys(resolved.defaults).length > 0) {
    before.push({
      value: resolved.defaults,
      source: { path: '<defaults>', format: 'defaults', precedence: 0, keys: [] },
    })
  }

  const after: Layer[] = []
  const fromEnv = envLayer(resolved.env, resolved.envPrefix, resolved.onWarning)
  if (Object.keys(fromEnv).length > 0) {
    after.push({ value: fromEnv, source: { path: '<env>', format: 'env', precedence: 4, keys: [] } })
  }
  if (Object.keys(resolved.overrides).length > 0) {
    after.push({
      value: resolved.overrides,
      source: { path: '<overrides>', format: 'overrides', precedence: 5, keys: [] },
    })
  }
  return { before, after }
}

function assemble(resolved: Resolved, fileLayers: Layer[]): Loaded<unknown> {
  const { before, after } = surroundingLayers(resolved)
  const layers = applyStrategy([...before, ...fileLayers, ...after], resolved.strategy)
  const config = mergeLayers(layers, {
    arrayMerge: resolved.arrayMerge,
    onWarning: resolved.onWarning,
  })
  return {
    config,
    // SPEC §7: `found` reflects files only. Defaults and env do not make it true.
    found: layers.some((layer) => layer.root !== undefined),
    sources: buildSources(layers, {
      ...(resolved.options.relativeTo === undefined ? {} : { relativeTo: resolved.options.relativeTo }),
    }),
  }
}

/**
 * Load `packageName`'s configuration from `./.config/<packageName>/` upward, layered over
 * `~/.config/<packageName>/`.
 *
 * Finding nothing is not an error: the result is the defaults with `found: false` and an empty
 * `sources`. Finding something broken **is** an error — a `ConfigError` naming the path — because
 * silently falling back to defaults when a YAML file has a tab in it is how a typo becomes an
 * incident.
 */
export async function load<S extends StandardSchemaV1>(
  packageName: string,
  options: LoadOptions<S> & { schema: S },
): Promise<Loaded<StandardSchemaV1.InferOutput<S>>>
export async function load<T = unknown>(
  packageName: string,
  options?: LoadOptions<undefined>,
): Promise<Loaded<T>>
export async function load(
  packageName: string,
  options: LoadOptions<StandardSchemaV1 | undefined> = {},
): Promise<Loaded<unknown>> {
  const { resolved, blocks } = planLoad(packageName, options as LoadOptions<StandardSchemaV1>)
  const explorer = createExplorer(packageName, { envPrefix: resolved.envPrefix })

  const fileLayers: Layer[] = []
  for (const block of blocks) {
    for (const ref of block.files) {
      fileLayers.push(fileLayer(ref, await loadConfigFile(explorer, ref), block.root, block.precedence))
    }
  }

  const result = assemble(resolved, fileLayers)
  if (resolved.options.schema === undefined) return result
  return {
    ...result,
    config: await validateConfig(result.config as Record<string, unknown>, resolved.options.schema, {
      ...(resolved.options.strict === undefined ? {} : { strict: resolved.options.strict }),
      onWarning: resolved.onWarning,
    }),
  }
}

/**
 * The synchronous flow. cosmiconfig ships `cosmiconfigSync`, so this costs one parallel
 * explorer construction rather than a second implementation — the discovery, merge, and
 * `sources` code is shared, and a table-driven test asserts the two agree.
 */
export function loadSync<S extends StandardSchemaV1>(
  packageName: string,
  options: LoadOptions<S> & { schema: S },
): Loaded<StandardSchemaV1.InferOutput<S>>
export function loadSync<T = unknown>(packageName: string, options?: LoadOptions<undefined>): Loaded<T>
export function loadSync(
  packageName: string,
  options: LoadOptions<StandardSchemaV1 | undefined> = {},
): Loaded<unknown> {
  const { resolved, blocks } = planLoad(packageName, options as LoadOptions<StandardSchemaV1>)
  const explorer = createExplorerSync(packageName, { envPrefix: resolved.envPrefix })

  const fileLayers: Layer[] = []
  for (const block of blocks) {
    for (const ref of block.files) {
      fileLayers.push(fileLayer(ref, loadConfigFileSync(explorer, ref), block.root, block.precedence))
    }
  }

  const result = assemble(resolved, fileLayers)
  if (resolved.options.schema === undefined) return result
  return {
    ...result,
    config: validateConfigSync(result.config as Record<string, unknown>, resolved.options.schema, {
      ...(resolved.options.strict === undefined ? {} : { strict: resolved.options.strict }),
      onWarning: resolved.onWarning,
    }),
  }
}

export type { LoadResult }

/**
 * Optional validation through the Standard Schema interface — SPEC §5, kinds `validation` and
 * `unknown-key`.
 *
 * No validator is depended on. Zod, Valibot, and ArkType all expose `~standard`, so the caller
 * brings theirs and this package keeps three runtime dependencies.
 */

import { ConfigError } from './errors.js'
import type { StandardSchemaV1, WarningSink } from './types.js'

function issueKeyPath(issue: StandardSchemaV1.Issue): string | undefined {
  if (issue.path === undefined || issue.path.length === 0) return undefined
  return issue.path
    .map((segment) =>
      typeof segment === 'object' && segment !== null ? String(segment.key) : String(segment),
    )
    .join('.')
}

/**
 * Best effort at the schema's declared top-level keys, for `strict`. Standard Schema does not
 * expose them, so this reaches for the two shapes that cover most of the ecosystem and gives up
 * cleanly otherwise — see the README: where the validator does not expose its keys, `strict`
 * defers to the validator's own strict mode rather than silently doing nothing.
 */
function knownTopLevelKeys(schema: StandardSchemaV1): string[] | null {
  const candidate = schema as unknown as Record<string, unknown>
  const shape = candidate['shape'] ?? (candidate['_def'] as Record<string, unknown> | undefined)?.['shape']
  const resolved = typeof shape === 'function' ? (shape as () => unknown)() : shape
  if (resolved !== null && typeof resolved === 'object') return Object.keys(resolved)
  const entries = candidate['entries'] // Valibot
  if (entries !== null && typeof entries === 'object') return Object.keys(entries as object)
  return null
}

export interface ValidateOptions {
  strict?: boolean
  onWarning?: WarningSink
}

/**
 * Returns the validator's **output** value, not the input. A schema that coerces or fills in
 * defaults therefore changes what `load` returns, which is the useful behavior and is
 * documented as such in the README.
 */
export async function validateConfig(
  config: Record<string, unknown>,
  schema: StandardSchemaV1,
  options: ValidateOptions = {},
): Promise<unknown> {
  checkUnknownKeys(config, schema, options)
  const result = await schema['~standard'].validate(config)
  return unwrap(result)
}

export function validateConfigSync(
  config: Record<string, unknown>,
  schema: StandardSchemaV1,
  options: ValidateOptions = {},
): unknown {
  checkUnknownKeys(config, schema, options)
  const result = schema['~standard'].validate(config)
  if (result instanceof Promise) {
    throw new ConfigError('validation', 'this schema validates asynchronously; use load() rather than loadSync()')
  }
  return unwrap(result)
}

function unwrap(result: StandardSchemaV1.Result<unknown>): unknown {
  if (result.issues === undefined) return result.value

  const [first] = result.issues
  const keyPath = first === undefined ? undefined : issueKeyPath(first)
  // The first issue by key path is the one named, but all of them ride along on `issues`: a
  // config with four wrong values should not take four runs to fix.
  throw new ConfigError('validation', first?.message ?? 'configuration failed validation', {
    ...(keyPath === undefined ? {} : { keyPath }),
    issues: result.issues,
  })
}

function checkUnknownKeys(
  config: Record<string, unknown>,
  schema: StandardSchemaV1,
  options: ValidateOptions,
): void {
  const known = knownTopLevelKeys(schema)
  if (known === null) return
  const unknown = Object.keys(config).filter((key) => !known.includes(key))
  if (unknown.length === 0) return

  const list = unknown.join(', ')
  if (options.strict === true) {
    throw new ConfigError('unknown-key', `configuration has unknown keys: ${list}`, {
      keyPath: unknown[0] as string,
    })
  }
  options.onWarning?.(`configuration has unknown keys: ${list} (set strict to make this an error)`)
}

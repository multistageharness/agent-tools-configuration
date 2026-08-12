/**
 * The error model of SPEC §5.
 *
 * Every failure carries a machine-readable `kind` from a closed list, so callers — and the
 * conformance suite — can branch on the failure without matching message text, which differs
 * per parser and per language.
 */

/** The closed list from SPEC §5. */
export type ConfigErrorKind =
  | 'not-found'
  | 'unreadable'
  | 'malformed'
  | 'duplicate-format'
  | 'unknown-key'
  | 'validation'

export interface ConfigErrorDetails {
  /** The file or directory the failure is about. Absolute at runtime. */
  path?: string
  /** One-based line, when the underlying parser reports one (SPEC §5, `malformed`). */
  line?: number
  /** One-based column, when the underlying parser reports one. */
  column?: number
  /** Dotted key path, for `validation` and `unknown-key`. */
  keyPath?: string
  /** Every issue a validator reported, when there was more than one. */
  issues?: readonly unknown[]
  cause?: unknown
}

export class ConfigError extends Error {
  readonly kind: ConfigErrorKind
  readonly path?: string
  readonly line?: number
  readonly column?: number
  readonly keyPath?: string
  readonly issues?: readonly unknown[]

  constructor(kind: ConfigErrorKind, message: string, details: ConfigErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'ConfigError'
    this.kind = kind
    if (details.path !== undefined) this.path = details.path
    if (details.line !== undefined) this.line = details.line
    if (details.column !== undefined) this.column = details.column
    if (details.keyPath !== undefined) this.keyPath = details.keyPath
    if (details.issues !== undefined) this.issues = details.issues
  }
}

export function isConfigError(value: unknown): value is ConfigError {
  return value instanceof ConfigError
}

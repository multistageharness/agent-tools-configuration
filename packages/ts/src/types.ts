/** The public type surface. SPEC §6 (options) and §7 (output contract). */

/** SPEC §7: the value of a `sources` entry's `format` field. */
export type Format =
  | 'toml'
  | 'yaml'
  | 'json'
  | 'jsonc'
  | 'ini'
  | 'dotenv'
  | 'env'
  | 'defaults'
  | 'overrides'

/** One contributing input. Every source that was read appears, winner or not. */
export interface Source {
  /** Absolute at runtime; rewritten by `relativeTo`. `<defaults>`, `<env>`, `<overrides>` for the non-file layers. */
  path: string
  format: Format
  /** The layer number from the SPEC §3.1 table. */
  precedence: number
  /** The top-level keys this source contributed, sorted. Empty for a file that parsed empty. */
  keys: string[]
}

export interface Loaded<T> {
  config: T
  /** True when at least one recognized *file* contributed. Defaults and env do not set it. */
  found: boolean
  /** Application order, lowest effective priority first (SPEC §3.1). */
  sources: Source[]
}

export type Strategy = 'layered' | 'first-match'
export type ArrayMerge = 'replace' | 'concat'

/** Where warnings go. Defaults to `console.warn`, which is stderr in Node. */
export type WarningSink = (message: string) => void

/**
 * The Standard Schema v1 interface, declared inline rather than depended on, so a caller can
 * bring Zod, Valibot, or ArkType and this package keeps three runtime dependencies.
 *
 * @see https://standardschema.dev
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
  }
}

export declare namespace StandardSchemaV1 {
  type Result<Output> = SuccessResult<Output> | FailureResult

  interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }

  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }

  interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
  }

  type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output']
}

export interface LoadOptions<S extends StandardSchemaV1 | undefined = undefined> {
  /** SPEC §3.2. Default `"layered"`. */
  strategy?: Strategy
  /** SPEC §4.3. Default `"replace"`. */
  arrayMerge?: ArrayMerge
  /** SPEC §2.3, opt-in extra stop condition. Inclusive. */
  stopDir?: string
  /** SPEC §4.5. Default: the package name uppercased, non-alphanumerics to `_`. */
  envPrefix?: string
  /** SPEC §2.6, optional profile files. */
  profile?: string
  /** SPEC §5: promotes `unknown-key` from a warning to an error. */
  strict?: boolean
  /** Overrides the platform home directory for SPEC §2.4. */
  home?: string
  /** Where the upward walk starts. Default `process.cwd()`. */
  cwd?: string
  /** The environment for the SPEC §4.5 layer. Default `process.env`. */
  env?: Record<string, string | undefined>
  /** Layer 0. */
  defaults?: Record<string, unknown>
  /** Layer 5. */
  overrides?: Record<string, unknown>
  /** Optional Standard Schema validator. Its output value becomes `config`. */
  schema?: S
  /** Rewrite `sources[].path` relative to this directory, forward-slashed. For the probe. */
  relativeTo?: string
  /** Diagnostics. Default `console.warn`. */
  onWarning?: WarningSink
}

/** `load` returns the schema's output type when a schema is given, and `unknown` otherwise. */
export type LoadResult<S extends StandardSchemaV1 | undefined, T> = S extends StandardSchemaV1
  ? Loaded<StandardSchemaV1.InferOutput<S>>
  : Loaded<T>

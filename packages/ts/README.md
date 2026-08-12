# `@multistageharness/config-discovery`

Load a program's configuration from `./.config/<packageName>/` — walking up from the working
directory — with a fallback to `~/.config/<packageName>/`, layered so project-local values win.

Wraps [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) for file loading, adds TOML,
INI, and `.env`, and implements the shared cross-language contract in
[`../spec/SPEC.md`](../spec/SPEC.md).

**Conformance: passing** — 18 of 19 fixtures pass and 1 skips on macOS, where an inherited ACL
under `/Users/Shared` means `chmod 000` cannot make a file unreadable. That case runs on Linux.
Verify with `npm run conformance`.

Implements **SPEC 1.0.0** ([`../spec/SPEC.md`](../spec/SPEC.md)). Last conformance run: **2026-08-11**.

## Install

```sh
npm install @multistageharness/config-discovery
```

Node 20 or newer.

## Quickstart

```ts
import { load } from '@multistageharness/config-discovery'

const { config, found, sources } = await load('mytool')

if (!found) console.error('no config file found; using defaults')
for (const source of sources) console.error(`${source.precedence} ${source.path}`)
```

`loadSync` is the same function without the `await`.

## Where it looks

`.config/<name>/` in your project, walking up from the working directory, layered over
`~/.config/<name>/`, with environment variables above both.

**The full account — search order, recognized filenames, how the layers combine, the `__` env
nesting rule, and how to read the `sources` output when a value surprises you — is
[`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md).** The normative version is
[`../spec/SPEC.md`](../spec/SPEC.md).

It is not restated here. Five packages restating one precedence table is five things that drift,
and a drifted README is worse than no README because it is believed.

## Options

Every option in SPEC §6, plus three that are specific to this language:

| Option | Default | Meaning |
| --- | --- | --- |
| `cwd` | `process.cwd()` | Where the upward walk starts. |
| `home` | the platform home | Overrides the user-level root's base. |
| `env` | `process.env` | The environment the `MYTOOL_*` layer reads. |
| `strategy` | `"layered"` | `"first-match"` uses only the nearest root that had a file. |
| `arrayMerge` | `"replace"` | `"concat"` appends instead, with no deduplication. |
| `stopDir` | — | An extra, inclusive stop for the walk. |
| `envPrefix` | package name, uppercased | Prefix for the environment layer. |
| `profile` | — | Also load `config.<profile>.<ext>`. |
| `strict` | `false` | Unknown keys become an error instead of a warning. |
| `defaults` / `overrides` | `{}` | The bottom and top layers. |
| `schema` | — | A Standard Schema validator; see below. |
| `relativeTo` | — | Emit `sources[].path` relative to this directory. |
| `onWarning` | `console.warn` | Where diagnostics go. |

`cwd` and `env` are the only two places the ambient process is read, and both are overridable —
that is what makes the conformance probe and every test in this package hermetic.

## Environment variables

```
MYTOOL_LOG__LEVEL=trace   →  { log: { level: "trace" } }
MYTOOL_PORT=5432          →  { port: 5432 }          // a number
MYTOOL_NAME=5432abc       →  { name: "5432abc" }     // a string
MYTOOL_SOME_KEY=1         →  { some_key: 1 }         // one underscore is literal
```

`__` splits nesting levels. Values are parsed as JSON when they parse and kept as strings when
they do not — the one coercion rule all five language implementations share.

## Validation

Bring any validator implementing [Standard Schema](https://standardschema.dev) — Zod, Valibot,
ArkType. This package depends on none of them.

```ts
import { z } from 'zod'
import { load } from '@multistageharness/config-discovery'

const schema = z.object({ log: z.object({ level: z.enum(['debug', 'info', 'warn']) }) })

const { config } = await load('mytool', { schema })
config.log.level // typed as "debug" | "info" | "warn"
```

The validator's **output** is what `load` returns, so a schema that coerces values or fills in
defaults changes the result. That is deliberate and usually what you want.

`strict: true` raises `kind: "unknown-key"` for a top-level key the schema does not declare —
but only when the validator exposes its keys (Zod's `shape`, Valibot's `entries`). Where it does
not, `strict` defers to the validator's own strict mode rather than silently doing nothing.

## Errors

Nothing found is **not** an error: you get `{config: defaults, found: false, sources: []}`. A
file that exists and is broken **is** an error, because silently falling back to defaults when a
YAML file has a tab in it turns a typo into an incident.

```ts
import { isConfigError } from '@multistageharness/config-discovery'

try {
  await load('mytool')
} catch (error) {
  if (isConfigError(error)) console.error(error.kind, error.path, error.line)
}
```

`kind` is one of `not-found`, `unreadable`, `malformed`, `duplicate-format`, `unknown-key`,
`validation`. Branch on it; never match the message text.

## Why cosmiconfig, but not `cosmiconfig.search()`

cosmiconfig's `search()` walks upward and stops at the **first** hit, returning one config. This
package collects **every** ancestor root and layers them nearest-wins, which `search()` cannot
express — and `strategy: "first-match"` recovers the stop-at-first reading afterward, from the
full list.

So discovery is hand-written here (`src/discover.ts`) and cosmiconfig does what it is best at
one directory down: reading an individual file and dispatching it through its loader registry.
The explorer is built with `searchPlaces: []` to make that unmistakable in the code.

## Development

```sh
npm install
npm test              # vitest, then the cross-language conformance suite
npm run typecheck     # includes the type-level assertions in the tests
npm run build
npm run conformance   # node ../spec/runner/run.mjs --probe ts
```

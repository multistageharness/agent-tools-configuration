# `config-discovery` (Rust)

Load a program's configuration from `./.config/<package_name>/` — walking up from the working
directory — with a fallback to `~/.config/<package_name>/`, layered so project-local values win.

Wraps [figment](https://github.com/SergioBenitez/Figment) as the parser and implements the shared
cross-language contract in [`../spec/SPEC.md`](../spec/SPEC.md).

**Conformance: passing, for the `--all-features` build** — 18 of 19 fixtures pass and 1 skips on
macOS, where an inherited ACL under `/Users/Shared` means `chmod 000` cannot make a file
unreadable. That case runs on Linux. Verify with `node ../spec/runner/run.mjs --probe rust`.

Implements **SPEC 1.0.0** ([`../spec/SPEC.md`](../spec/SPEC.md)). Last conformance run: **2026-08-11**.

## Install

```toml
[dependencies]
config-discovery = "0.1"
```

## Quickstart

```rust,no_run
# fn main() -> Result<(), config_discovery::Error> {
let loaded = config_discovery::load_default("mytool")?;

if !loaded.found {
    eprintln!("no config file found; using defaults");
}
for source in &loaded.sources {
    eprintln!("{} {}", source.precedence, source.path);
}
# Ok(())
# }
```

For a struct, use `extract`:

```rust,no_run
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    port: u16,
}

# fn main() -> Result<(), config_discovery::Error> {
let settings: Settings = config_discovery::load_default("mytool")?.extract()?;
# Ok(())
# }
```

## Feature flags

| Feature | Default | What it enables |
| --- | --- | --- |
| `toml` | yes | `config.toml`, via `figment/toml` |
| `json` | yes | `config.json` and `config.jsonc`, via `figment/json` |
| `yaml` | no | `config.yaml` / `config.yml`, via `figment/yaml` |
| `ini` | no | `config.ini`, via an in-crate parser — figment has no INI provider |
| `dotenv` | no | `.env`, via `dotenvy` |
| `all` | no | Everything above |

**A file whose format feature is disabled at compile time is _skipped with a warning_, not an
error.** That is this crate's one documented deviation from SPEC §2.5, which says every
recognized file present must be loaded. The alternative — failing because a user wrote a
`config.yaml` and the binary was built without the `yaml` feature — punishes the user for a
build-time decision they did not make. The warning names the file and the missing feature.

The conformance probe builds with `--all-features`, so a fixture can never pass because a format
was compiled out.

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

`Options::builder()` covers every SPEC §6 option: `strategy`, `array_merge`, `stop_dir`,
`env_prefix`, `profile`, `strict`, `home`, `cwd`, `env`, `defaults`, `overrides`, `relative_to`,
`on_warning`.

`cwd`, `home`, and `env` replace the only three ambient inputs `load` reads. That is what makes
the conformance probe and every test in this crate hermetic.

## Environment variables

```
MYTOOL_LOG__LEVEL=trace   ->  {"log": {"level": "trace"}}
MYTOOL_PORT=5432          ->  {"port": 5432}          // a number
MYTOOL_NAME=5432abc       ->  {"name": "5432abc"}     // a string
MYTOOL_SOME_KEY=1         ->  {"some_key": 1}         // one underscore is literal
```

`figment::providers::Env` is deliberately not used: it applies its own coercion rather than the
spec's parse-as-JSON-or-keep-the-string rule, and it reads the process environment directly. See
the header of `src/env.rs`.

## Errors

Nothing found is **not** an error: you get `found: false` and an `Ok`. A file that exists and is
broken **is** an error, because silently falling back to defaults when a YAML file has a tab in
it turns a typo into an incident.

`Error` is `#[non_exhaustive]`, and `Error::kind()` returns the SPEC §5 kind string —
`not-found`, `unreadable`, `malformed`, `duplicate-format`, `unknown-key`, `validation`. Match on
the variant or compare the kind; never match the message text.

`strict` is honest about its limits: the real unknown-key check is serde's, so it happens in
`extract` against a type carrying `#[serde(deny_unknown_fields)]`. Without such a type there is
nothing to compare against, and `load` says so on the warning channel rather than pretending.

## What figment does here, and what it does not

figment is **the parser**. Each recognized file becomes one provider and `Provider::data` hands
back the parsed dictionary; figment's layering, profiles, and `Figment::merge` chain are not
used. The reason is arrays: figment's merge replaces or extends them depending on the provider
and the profile mechanism, and there is no switch that makes it always replace with an opt-in
concat (SPEC §4.3). Layer precedence is also ours to define — including the rule that a root's
`.env` applies inside that root's block, which a flat merge chain cannot express.

One consequence worth knowing: `Toml::file(path)` and its siblings treat an unreadable file as
*no data* and return `Ok` with an empty dictionary, because a figment provider is allowed not to
exist. This crate therefore reads every file itself before handing the text to a provider, so an
unreadable file is the `unreadable` error SPEC §5 requires rather than a silent empty result.

No figment type appears in this crate's public API.

## Development

```sh
cargo test --all-features      # unit tests plus the cross-language conformance suite
cargo clippy --all-features -- -D warnings
cargo doc --no-deps --all-features
```

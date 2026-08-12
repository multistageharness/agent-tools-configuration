# `config-discovery` (Python)

Load a program's configuration from `./.config/<package_name>/` — walking up from the working
directory — with a fallback to `~/.config/<package_name>/`, layered so project-local values win.

Wraps [Dynaconf](https://www.dynaconf.com/) for file reading and implements the shared
cross-language contract in [`../spec/SPEC.md`](../spec/SPEC.md).

**Conformance: passing** — 18 of 19 fixtures pass and 1 skips on macOS, where an inherited ACL
under `/Users/Shared` means `chmod 000` cannot make a file unreadable. That case runs on Linux.
Verify with `node ../spec/runner/run.mjs --probe py`.

Implements **SPEC 1.0.0** ([`../spec/SPEC.md`](../spec/SPEC.md)). Last conformance run: **2026-08-11**.

## Install

```sh
pip install config-discovery
```

Python 3.9 or newer.

## Quickstart

```python
from config_discovery import load

result = load("mytool")

if not result.found:
    print("no config file found; using defaults")
for source in result.sources:
    print(source.precedence, source.path)

result.config  # a plain dict
```

**`result.config` is a plain `dict`, not a `LazySettings`.** Nothing Dynaconf-shaped crosses the
boundary: no lazy attribute access, no case-insensitive lookups, no `@` markers. `load` asserts
it, so a leak fails a test rather than surprising a consumer.

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

| Keyword | Default | Meaning |
| --- | --- | --- |
| `cwd` | `Path.cwd()` | Where the upward walk starts. |
| `home` | `Path.home()` | Overrides the user-level root's base. |
| `env` | `os.environ` | The environment the `MYTOOL_*` layer reads. |
| `strategy` | `"layered"` | `"first-match"` uses only the nearest root that had a file. |
| `array_merge` | `"replace"` | `"concat"` appends instead, with no deduplication. |
| `stop_dir` | `None` | An extra, inclusive stop for the walk. |
| `env_prefix` | package name, uppercased | Prefix for the environment layer. |
| `profile` | `None` | Also load `config.<profile>.<ext>`. |
| `strict` | `False` | Unknown keys become an error instead of a warning. |
| `defaults` / `overrides` | `None` | The bottom and top layers. |
| `schema` | `None` | A validator; see below. |
| `relative_to` | `None` | Emit `sources[].path` relative to this directory. |
| `on_warning` | stderr | Where diagnostics go. |

`cwd`, `home`, and `env` are the only three places the ambient process is read, and each is
overridable — that is what makes the conformance probe and every test in this package hermetic.

## Environment variables

```
MYTOOL_LOG__LEVEL=trace   ->  {"log": {"level": "trace"}}
MYTOOL_PORT=5432          ->  {"port": 5432}          # an int
MYTOOL_NAME=5432abc       ->  {"name": "5432abc"}     # a str
MYTOOL_SOME_KEY=1         ->  {"some_key": 1}         # one underscore is literal
```

`__` splits nesting levels. Values are parsed as JSON when they parse and kept as strings when
they do not.

**Dynaconf's own environment loader is not used.** Its `@int` / `@json` markers and bare-token
inference do not agree with the spec's rule at the edges, and it reads the process environment
directly, which would make results depend on the developer's shell. See the header comment in
`src/config_discovery/env.py` before changing it.

## Validation

Pass any callable. It receives the merged dict and its **return value** becomes `config`, so a
validator that coerces or fills in defaults changes the result — which is usually what you want.

```python
from pydantic import BaseModel
from config_discovery import load

class Settings(BaseModel):
    port: int

result = load("mytool", schema=Settings)
result.config.port
```

A Pydantic model class is accepted directly: `model_validate` is preferred when the schema
offers it, because `BaseModel.__init__` does not take a positional dict.

`strict=True` raises `kind="unknown-key"` for a top-level key the schema does not declare — but
only when the fields are discoverable (`model_fields` on a Pydantic model, `__dataclass_fields__`
or class annotations otherwise). For a plain function, which declares nothing, `strict` defers to
the validator's own strictness rather than silently doing nothing.

## Errors

Nothing found is **not** an error: you get `Loaded(config=defaults, found=False, sources=[])`. A
file that exists and is broken **is** an error, because silently falling back to defaults when a
YAML file has a tab in it turns a typo into an incident.

```python
from config_discovery import ConfigError, load

try:
    load("mytool")
except ConfigError as error:
    print(error.kind, error.path, error.line)
```

`kind` is one of `not-found`, `unreadable`, `malformed`, `duplicate-format`, `unknown-key`,
`validation`. Branch on it; never match the message text.

## Notes on the Dynaconf wrapping

Two decisions worth knowing before editing `src/config_discovery/loaders.py`:

- **One file per `Dynaconf` instance.** Handed the whole `settings_files` list it would apply its
  own layering, which is not the spec's — it merges lists and is case-insensitive.
- **`loaders=[]`.** That disables Dynaconf's *core* loaders, which otherwise read the process
  environment straight into the result. Without it, an exported shell variable silently becomes
  configuration.
- The `ini` extra is a hard requirement, not a nicety: without `configobj`, Dynaconf returns
  `{}` for a `config.ini` and only warns.

## Development

```sh
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest          # unit tests plus the cross-language conformance suite
.venv/bin/mypy --strict src
.venv/bin/ruff check .
```

# `packages/` — a guide for AI agents

This file explains what the six directories under `packages/` are, what the pattern behind them
is, and what you — an agent asked to use, change, or extend them — must do and must not do.

It is a guide, not a specification. Where this file and [`spec/SPEC.md`](spec/SPEC.md) disagree,
**the spec wins** and this file is the bug.

---

## 1. The one-paragraph model

Six directories: five language packages plus one spec. All five packages do the *same job* —
load a program's configuration from `./.config/<packageName>/`, walking up from the working
directory, falling back to `~/.config/<packageName>/`, layered so project-local values win — and
they are all judged against the *same* written contract and the *same* pile of test data.

```
packages/
  spec/       the normative contract: SPEC.md, PROBE.md, CANONICAL.md, fixtures/, runner/
  ts/         TypeScript / Node      → @multistageharness/config-discovery   (npm)
  py/         Python                 → config-discovery                      (PyPI)
  golang/     Go                     → github.com/…/packages/golang          (Go proxy)
  java/       Java                   → io.github.multistageharness:…-core    (Maven Central)
  rust/       Rust                   → config-discovery                      (crates.io)
```

`spec/` is **not** a package. It ships nothing to a registry. It holds the specification, the
language-agnostic fixture suite, and the Node runner that drives every implementation through the
same cases.

Folders are named for the **language**, not the registry name — `golang/` because the Go
toolchain has opinions about `go/`, `ts/` because the siblings are short. The registry name lives
in the support matrix in [`README.md`](README.md) and nowhere else.

---

## 2. What the pattern is, and why

The pattern is **spec-first polyglot implementation with a process-boundary conformance probe**.
Four properties define it. If you are asked "what is the pattern here", this is the answer.

**1. One normative document, five implementations.** Behavior is defined once, in prose with RFC
2119 keywords, in `spec/SPEC.md`. No package defines behavior. A package that behaves differently
from the spec is wrong even if its own tests pass.

**2. The five packages are peers and never touch each other.** A package MUST NOT import from,
build against, vendor, or read the source of another language package. The only shared artifacts
are `spec/SPEC.md` (a document) and `spec/fixtures/` (data) — neither is code anyone links to.
This is deliberate: each language is meant to be implementable alone, months apart, by someone
who has never read the others.

> **Corollary you will need:** if you find yourself opening a sibling package to work out what
> yours should do, **the spec is missing a sentence — fix the spec**, then implement from it.
> Copying behavior across languages is how a spec quietly stops being the source of truth.

**3. Conformance is a test result, not a claim.** Every package ships an executable at
`<lang>/conformance/run` that exposes `load` over a process boundary — flags in, one JSON document
out, an exit code. The runner needs no knowledge of any language; it spawns a path. A package's
row in the support matrix says `passing` only when
`node packages/spec/runner/run.mjs --probe <lang>` exits 0 over the **full** fixture set.

**4. Documentation is written once and linked, not restated.** No package README repeats the
precedence table. Five copies would be five things to keep in sync, and they would not stay in
sync. Behavior lives in `docs/CONFIGURATION.md` (for users) and `spec/SPEC.md` (normative); a
package README says only what it wraps and what is idiomatic in its language.

Why this shape at all: the same `.config/<packageName>/` directory is expected to be readable by
five different language implementations, possibly on three operating systems. Every per-ecosystem
deviation multiplies across that matrix — so the spec does not bend for an ecosystem's defaults,
and each package fights its wrapped library rather than inheriting its opinions.

---

## 3. Which mode you are in

Decide this before you touch anything. The two modes have different rules.

| If the task is… | You are in | Read |
| --- | --- | --- |
| Use this config loader from some other project's code | **Consumer mode** (§4) | the language README + `docs/CONFIGURATION.md` |
| Change, fix, extend, or add a package here | **Contributor mode** (§5) | `spec/SPEC.md` first, always |

---

## 4. Consumer mode — using a package

### 4.1 Entry points

Every language exposes the same three-field result — `config`, `found`, `sources` — spelled in
that language's idiom.

```ts
// ts
import { load } from '@multistageharness/config-discovery'
const { config, found, sources } = await load('mytool')   // loadSync is the same without await
```
```python
# py
from config_discovery import load
result = load("mytool")          # result.config is a plain dict, never a LazySettings
```
```go
// golang
result, err := configdiscovery.Load("mytool")             // result.Config is map[string]any
var settings Settings; err = result.Unmarshal(&settings)  // or UnmarshalStrict()
```
```java
// java
Loaded loaded = ConfigDiscovery.load("mytool");           // loaded.config() is a JsonNode
Settings settings = loaded.as(Settings.class);
```
```rust
// rust
let loaded = config_discovery::load_default("mytool")?;   // or load(name, Options)
let settings: Settings = loaded.extract()?;
```

### 4.2 The behavior you must not get wrong

These are the parts an agent most often invents. All are normative.

- **The recognized filename list is closed**, in this order, later winning within one directory:
  `config.toml`, `config.yaml`, `config.yml`, `config.json`, `config.jsonc`, `config.ini`, `.env`.
  No other name is recognized and the list is **not extensible through options**. Do not tell a
  user to add `settings.yaml` or `config.local.json`.
- **`config.yaml` beside `config.yml` in one directory is an error** (`duplicate-format`), not a
  silent pick.
- **Layers, lowest to highest:** 0 defaults → 1 user-level files → 2 project-local files →
  3 `.env` → 4 prefixed env vars → 5 programmatic overrides. Layer 3 is a **per-root overlay**:
  a root's `.env` applies at the end of *that root's* block, so a user-level `.env` still loses to
  a project-local `config.toml`.
- **Env var mapping:** strip `<PREFIX>_`, lowercase, split on `__` (a single `_` is literal),
  then **parse the value as JSON and keep the raw string if it does not parse**. So
  `MYTOOL_PORT=5432` is the number, `MYTOOL_NAME=5432abc` is the string, `MYTOOL_SOME_KEY=1` is
  `some_key`. That coercion rule is the single most-violated line in the spec, because most of
  the wrapped libraries stringify everything.
- **Maps deep-merge; arrays replace wholesale.** `arrayMerge: "concat"` appends and does **not**
  deduplicate. Element-wise merging by index never happens.
- **An explicit null in a higher layer deletes the key.** Absent ≠ null. TOML has no null literal,
  so a TOML file cannot unset — and no implementation may invent a `"null"` / `"~"` / `""`
  sentinel.
- **Nothing found is not an error.** You get the defaults, `found: false`, empty `sources`. But a
  file that **exists and is broken is** an error that aborts the whole load — no partial merge is
  ever returned alongside an error. Silently falling back when a YAML file has a tab in it turns
  a typo into an incident.
- **`sources` lists every source that was read, including the ones that lost.** That is its whole
  purpose: the user who expected `debug` needs to see what overrode it. A file that parsed empty
  still appears, with `keys: []`.
- **`found` reflects files only.** Defaults plus two env vars and no file is `found: false` with a
  non-empty `sources`.
- **Error `kind` is a closed list** — `not-found`, `unreadable`, `malformed`, `duplicate-format`,
  `unknown-key`, `validation`. Branch on `kind`; **never** match message text, which differs per
  parser and per language.
- **The user-level root is the same path on every platform**, including Windows:
  `%USERPROFILE%\.config\<packageName>\`. `%APPDATA%` is never consulted. `$XDG_CONFIG_HOME`
  overrides it only when set to an **absolute** path; a relative or empty value is ignored with a
  warning.

### 4.3 Options

Every language accepts the full SPEC §6 set, spelled idiomatically — `cwd`, `home`, `stopDir`,
`strategy`, `arrayMerge`, `envPrefix`, `profile`, `strict`, `defaults`, `overrides`, plus each
package's `relativeTo`/`schema`/warning handler. Go uses `With…` functional options; Java and Rust
use builders; Python uses snake_case keywords.

Two things to know:

- **An unknown option name is an error, not an ignore**, and so is an out-of-set value —
  `strategy: "first_match"` is rejected, not treated as a synonym.
- **`cwd`, `home`, and `env` are the only ambient inputs any implementation reads, and all three
  are overridable.** That is what makes the probe and every test hermetic. If you are writing a
  test for a downstream consumer, pass all three rather than mutating the process.

### 4.4 Where to send a human

`docs/CONFIGURATION.md` — written for someone configuring a tool, with a worked example and a
"when something is not what you expected" section. Do not paste the precedence table into a new
README; link it.

---

## 5. Contributor mode — changing this tree

### 5.1 Read order

1. `spec/SPEC.md` — behavior. The only source of truth.
2. `spec/PROBE.md` — the probe contract, if you touch `conformance/run`.
3. `spec/CANONICAL.md` — output serialization, if you touch fixtures or the runner.
4. `spec/fixtures/README.md` — fixture layout, if you add a case.
5. The target package's own README — what it wraps, and what fights its library.

### 5.2 What every language package MUST provide

1. **A public `load` entry point** taking a package name plus the SPEC §6 options, returning the
   §7 output contract (`config`, `found`, `sources`).
2. **An executable `conformance/run`** satisfying `PROBE.md`. Without it, the runner reports the
   language as *not registered* rather than passing.
3. **A `RELEASE.md`** with that ecosystem's concrete publish steps.
4. **A `README.md`** that says what the package wraps and **links** to `docs/CONFIGURATION.md`
   rather than restating behavior.

### 5.3 The shared internal shape

Not required by the spec, but every package converged on it, and matching it is the path of least
surprise: `discover` (the upward walk and root resolution) · `loaders` (one file → a map) · `env`
(SPEC §4.5) · `merge` (§4) · `sources` (§7) · `errors` (§5) · plus validation/binding where the
language has one (`validate.ts`, `validate.py`, `unmarshal.go`, `Binding.java`, `extract`).

If you are adding behavior, it almost certainly belongs in whichever of those seven it belongs to
in the other four languages — even though you must not read them to find out.

### 5.4 The probe contract, compressed

`packages/<lang>/conformance/run`, executable bit set, spawnable with `packages/<lang>/` as cwd.

| Flag | Required | Meaning |
| --- | --- | --- |
| `--package-name <name>` | yes | passed through to `load` |
| `--cwd <abs>` | yes | where the walk starts; use verbatim |
| `--home <abs>` | yes | the §2.4 base; **never read the real home** |
| `--env KEY=VALUE` | repeatable | **the complete environment** for the env-var layer |
| `--options <json>` | no | the SPEC §6 object |
| `--fixture-root <abs>` | yes | `sources[].path` is emitted relative to this, forward-slashed |

- **stdout carries exactly one JSON document and nothing else.** No banner, no progress line, no
  build chatter. Every diagnostic goes to stderr. A stray line is a *protocol failure*, reported
  distinctly from a wrong result because the causes are unrelated.
- **`--env` fully replaces the environment** for the env-var layer. A developer with
  `MYTOOL_LOG__LEVEL` exported in their shell must not change the result. `$XDG_CONFIG_HOME`
  arrives through `--env` too.
- **Exit codes carry meaning:** `0` = a result document · `1` = the library correctly rejected the
  input (a *passing* result for an error fixture) · `2` = the probe itself is broken — bad flags,
  build failure, missing dependency, **unsupported option**, crash. Never use 1 for a crash or 2
  for a config file you correctly rejected. An option the probe does not support MUST exit 2, not
  silently pass; a probe that ignores `arrayMerge` and prints a result is claiming conformance it
  does not have.
- **A probe may build on first use but should not rebuild per invocation** — the runner spawns it
  once per fixture. All five existing probes are `sh` launchers that rebuild only when sources are
  newer than the artifact. Follow that.

### 5.5 Adding a fixture

Fixtures are **hand-derived from the spec**. A fixture produced by running an implementation and
recording the output is a regression test for that implementation's bugs, not a conformance test —
do not create one that way, ever.

```
<case-name>/
  manifest.json     # inputs; must validate against fixtures/manifest.schema.json
  expected.json     # canonical (CANONICAL.md) required output, hand-computed
  tree/project/…    # the synthetic working directory and its ancestors
  tree/home/…       # the synthetic home
```

- **No absolute paths, no `$HOME`, nothing machine-dependent.** `tree/` is the whole world.
- **`dot-git` markers.** Git will not track a path with a `.git` component, so the stop marker is
  committed as a regular file named `dot-git`; the runner materializes `.git` beside each one and
  removes it in a `finally`. Put one at the top of every case's `project/` unless the case is
  about not having one.
- **`${TREE}`** is the only token the runner expands, only inside `manifest.env` values, for cases
  needing an absolute path (today only `XDG_CONFIG_HOME`).
- **`manifest.specClause`** records the clause the case was derived from. It is where a reader goes
  when the case fails.
- **Name the behavior, not a number** — `both-array-replace`, `stop-at-git-root`. Never `case-07`.
- **Verify against the reference probe**, which implements the spec naively for exactly this
  purpose:
  `node packages/spec/runner/run.mjs --probe-path packages/spec/runner/reference --fixture <case>`.
  If it disagrees with your hand-derived expectation, one of the two is wrong, and finding out
  which is the point.
- **A case that can skip can hide a defect.** `skipOn` is legitimate (Windows cannot express mode
  `000`), but prefer adding a portable sibling asserting the same clause — that is why
  `unreadable-directory` exists next to `unreadable-permissions`.

### 5.6 Adding a sixth language

Everything above applies unchanged. Create `packages/<lang>/`, provide the four things from §5.2,
add a row to the support matrix in `README.md`, and add the language to the `LANGUAGES` list in
`spec/runner/run.mjs` so the runner looks for its probe.

**Do not change `spec/SPEC.md` to accommodate an ecosystem's defaults.** If an ecosystem genuinely
cannot express a requirement, that is a change-control decision about the contract — raise it —
not a local exception you take yourself.

---

## 6. Commands

```sh
./test.sh                                              # every package + conformance, one table
./test.sh rust go                                      # only those
./test.sh --list                                       # what can run here, and why anything cannot
./test.sh --strict                                     # a missing toolchain is a failure, not a skip

node packages/spec/runner/run.mjs                      # which languages have a probe
node packages/spec/runner/run.mjs --list               # every fixture, every registered probe
node packages/spec/runner/run.mjs --probe ts           # run the suite against one language
node --test packages/spec/runner/run.test.mjs          # test the harness itself
```

The runner needs Node and nothing else — no install step, no lockfile, no dependency.

Per language, conformance and the package's own tests:

| Language | Conformance | Own tests |
| --- | --- | --- |
| TypeScript | `run.mjs --probe ts` | `cd packages/ts && npm ci && npm test` |
| Python | `run.mjs --probe py` | `cd packages/py && pip install -e ".[dev]" && pytest` |
| Go | `run.mjs --probe golang` | `cd packages/golang && go test ./...` |
| Java | `run.mjs --probe java` | `cd packages/java && ./gradlew test` |
| Rust | `run.mjs --probe rust` | `cd packages/rust && cargo test --all-features` |

The two columns overlap deliberately — each language's own test command already runs the
conformance suite, so a conformance regression fails the package's tests, not only CI.

And the harness gates, which CI runs:

```sh
node packages/spec/runner/run.mjs --probe-path packages/spec/runner/reference          # must pass
node packages/spec/runner/run.mjs --probe-path packages/spec/runner/reference/broken   # must fail
```

`test.sh` skips a package whose toolchain is absent — printing the command that would fix it —
so a Rust contributor without a JDK still gets a useful run. Use `--strict` when you need the
absence to be a failure.

---

## 7. Triage

| Symptom | What it means |
| --- | --- |
| Runner says a language is *not registered* | No executable `conformance/run`, or the executable bit is unset. |
| Probe exit 2 | The harness is broken — bad flag, build failure, unsupported option. The fixture result is **unknown** and counts as evidence for nothing. |
| Probe exit 1 on an error fixture | Correct. The library rejected bad input; that is a pass. |
| "protocol failure" rather than a diff | Something other than one JSON document reached stdout. Find the stray print or build line and send it to stderr. |
| Diff shows `5432` vs `"5432"` | The env/INI coercion rule (§4.5 step 5). Never a formatting nit — the wrapped library is stringifying. Canonicalization deliberately does not paper over type. |
| Diff shows key order or indentation only | Not a failure the runner can report — it canonicalizes both sides first. If you are seeing it, you are diffing by hand. |
| A fixture passes locally and fails in CI | Ambient environment leaked into the env layer, or the real home was read. See PROBE.md §3. |
| `unreadable-permissions` skips on macOS | Expected under `/Users/Shared`, where an inherited ACL defeats `chmod 000`. It runs on Linux, and `unreadable-directory` covers the clause portably. |

---

## 8. Deliberate divergences

The suite proves the five agree on everything it covers. These are the places they knowingly do
not — each documented in its own package. Do not "fix" them.

| Divergence | Where | Why |
| --- | --- | --- |
| A file whose format feature is compiled out is **skipped with a warning**, not an error | `rust/` | Consumers pay only for the formats they enable. The probe builds `--all-features`, so conformance is never claimed for a compiled-out format. |
| The Spring adapter does not reproduce SPEC §3 ordering | `java/spring/` | Spring interleaves its own property sources and a library cannot reorder them. `java/core` reproduces §3 exactly and is what the probe tests; the real order is published in `java/spring/README.md`. |
| An explicit null cannot unset from a TOML file | all five | TOML has no null literal. A format limitation stated in SPEC §4.4, not an implementation difference. |
| `strict` unknown-key checking depends on the validator | `ts/`, `py/`, `rust/` | Standard Schema, a Python callable, and serde expose declared fields differently or not at all. Each package documents which mechanism applies rather than silently doing nothing. |

Each package also fights its wrapped library in a specific, documented way — cosmiconfig's
`search()` stops at the first hit; Viper lowercases every key; Dynaconf's core loaders read the
process environment; figment applies its own coercion; dotenv-java merges `System.getenv()` by
default. Every one of those is bypassed on purpose, with a header comment at the bypass site.
**Read that comment before changing the code under it.**

---

## 9. Rules, condensed

1. Behavior comes from `spec/SPEC.md`. Never from a sibling implementation.
2. Never import, vendor, or read across language packages.
3. Never restate the precedence table — link `docs/CONFIGURATION.md`.
4. Never extend the recognized-filename list, and never make it extensible.
5. Never match error message text; branch on `kind`.
6. Never derive `expected.json` by running an implementation.
7. Never let the ambient environment, cwd, or home reach `load` in a test or probe.
8. Never print anything but one JSON document to a probe's stdout.
9. Never flip a matrix row to `passing` on a subset — full fixture set, exit 0, or it is
   `not started`.
10. If the spec cannot answer your question, the spec is missing a sentence. Fix the spec.

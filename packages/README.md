# `packages/`

[![conformance](https://github.com/multistageharness/agent-tools-configuration/actions/workflows/conformance.yml/badge.svg)](https://github.com/multistageharness/agent-tools-configuration/actions/workflows/conformance.yml)

Five language packages that load a program's configuration from `./.config/<packageName>/`
first and `~/.config/<packageName>/` second, layered so project-local values win — plus the
shared contract they are all judged against.

```
packages/
  spec/       the normative contract: SPEC.md, PROBE.md, CANONICAL.md, fixtures/, runner/
  ts/         TypeScript / Node
  py/         Python
  golang/     Go
  java/       Java
  rust/       Rust
```

`spec/` is not a package. It ships nothing to a registry; it holds the specification, the
language-agnostic fixture suite, and the runner that drives every implementation through the
same cases.

[`AGENTS.md`](AGENTS.md) explains this tree to an AI agent — the pattern, the two modes of
working in it, the probe and fixture contracts in compressed form, and the rules that are easiest
to break by accident.

Folders are named for the **language**, not for the registry name the package will be published
under. `golang/` rather than `go/` because `go/` is a name the Go toolchain has opinions about,
and `ts/` rather than `typescript/` because the sibling folders are short. The registry name
lives in the matrix below and nowhere else.

---

## What a language package MUST provide

1. **A public `load` entry point** taking a package name plus the options of
   [`spec/SPEC.md` §6](spec/SPEC.md) and returning the §7 output contract — `config`, `found`,
   and `sources` — spelled in that language's idiom.
2. **An executable `conformance/run`** satisfying [`spec/PROBE.md`](spec/PROBE.md). This is how
   the package proves it conforms; without it the runner reports the language as *not
   registered* rather than passing.
3. **A `RELEASE.md`** with that ecosystem's publish steps — version bump, build, sign, publish,
   verify — concrete enough to follow without knowing the ecosystem well.
4. **A `README.md`** that says what the package wraps and links to `docs/CONFIGURATION.md` for
   behavior rather than restating it. Five copies of the precedence table would be five things
   to keep in sync, and they would not stay in sync.

## Independence

The five language packages are **peers**. A package MUST NOT import from, build against, or
read the source of another language package. The only shared artifacts are
[`spec/SPEC.md`](spec/SPEC.md) and [`spec/fixtures/`](spec/fixtures/) — a document and a pile of
data, neither of which is code anyone links to.

This is deliberate: each language is meant to be implementable on its own, one at a time,
possibly months apart, by someone who has never read the others. If you find yourself needing to
look at a sibling package to make yours work, the spec is missing a sentence — fix the spec.

## Support matrix

| Language | Folder | Wraps | Package name | Registry | Conformance |
| --- | --- | --- | --- | --- | --- |
| TypeScript | `ts/` | cosmiconfig | `@multistageharness/config-discovery` | npm | passing |
| Python | `py/` | Dynaconf | `config-discovery` | PyPI | passing |
| Go | `golang/` | Viper (see below) | `github.com/multistageharness/agent-tools-configuration/packages/golang` | Go module proxy | passing |
| Java | `java/` | Jackson core + optional Spring Boot adapter | `io.github.multistageharness:config-discovery-core` (Java package `dev.configdiscovery`) | Maven Central | passing |
| Rust | `rust/` | figment | `config-discovery` | crates.io | passing |

All five implement **SPEC 1.0.0**. Every row above was verified by re-running that language's
probe on **2026-08-11**, not by copying the row above it.

**Name availability, checked 2026-08-11:**

| Registry | Name | Status |
| --- | --- | --- |
| npm | `@multistageharness/config-discovery` | available |
| npm | ~~`config-discovery`~~ (unscoped) | **taken** — which is why the npm package is scoped |
| PyPI | `config-discovery` | available |
| crates.io | `config-discovery` | available |
| Maven Central | `io.github.multistageharness` | available; `dev.configdiscovery` would need domain verification, see [`java/RELEASE.md`](java/RELEASE.md) |
| Go proxy | `github.com/…/packages/golang` | unpublished, as expected — Go publishes by tagging |

Re-check immediately before the first publish of each: the window between checking and
publishing is the whole risk.

**The rule for the Conformance column:** flip your row to `passing` only when

```
node packages/spec/runner/run.mjs --probe <lang>
```

exits 0 over the **full** fixture set. Not a subset, not with a case commented out. A skipped
case is acceptable only when its manifest declares `skipOn` for the platform in use. Anything
else in that cell — `partial`, `mostly` — means `not started`.

## Known differences between the languages

The suite proves the five agree on everything it covers. These are the places they deliberately
do not, each documented in its own package:

| Difference | Where | Why |
| --- | --- | --- |
| A file whose format feature is disabled at compile time is **skipped with a warning**, not an error. | `rust/` | Rust consumers pay only for the formats they enable. Failing because a user wrote `config.yaml` and the binary was built without the `yaml` feature punishes them for a build-time decision they did not make. The probe builds `--all-features`, so conformance is never claimed for a compiled-out format. |
| The Spring adapter does **not** reproduce SPEC §3 ordering. | `java/spring/` | Spring interleaves its own property sources — command line, system properties, `application.yml` — and a library cannot reorder them. `java/core` reproduces SPEC §3 exactly and is what the probe tests. [The real order is published.](java/spring/README.md) |
| An explicit null cannot unset a key from a TOML file. | all five | TOML has no null literal. Use `config.json` or `config.yaml` at the overriding layer. This is a format limitation, stated in SPEC §4.4, not an implementation difference. |
| `strict` unknown-key checking depends on the validator. | `ts/`, `py/`, `rust/` | Standard Schema, a plain Python callable, and serde each expose their declared fields differently, or not at all. Each package documents which mechanism applies rather than silently doing nothing. |

## Adding a sixth language

Everything above applies unchanged. Create `packages/<lang>/`, provide the four things, add a
row to the matrix, and add the language to the `LANGUAGES` list in
[`spec/runner/run.mjs`](spec/runner/run.mjs) so the runner looks for its probe. Do not change
`spec/SPEC.md` to accommodate an ecosystem's defaults — the point of the spec is that it does
not bend per language. If the ecosystem genuinely cannot express a requirement, that is a
change-control decision about the contract, not a local exception.

## Running the suite

```
node packages/spec/runner/run.mjs                  # which languages have a probe
node packages/spec/runner/run.mjs --list           # every fixture, every registered probe
node packages/spec/runner/run.mjs --probe ts       # run the suite against TypeScript
node --test packages/spec/runner/run.test.mjs      # test the harness itself
```

The runner needs Node and nothing else — no install step, no lockfile, no dependency.

### The same checks CI runs, locally

```
./test.sh                 # every package, one summary table
./test.sh rust go         # only those
./test.sh --list          # what can run here, and why anything cannot
./test.sh --strict        # a package that cannot run is a failure, not a skip
```

`test.sh` runs exactly the commands below, in CI's order, and prints a package's output only
when it fails. It skips a package whose toolchain is absent — with the command that would fix
it — rather than failing, so a Rust contributor without a JDK still gets a useful run.

The individual commands, for when you want one of them:

| Language | Conformance | The package's own tests |
| --- | --- | --- |
| TypeScript | `node packages/spec/runner/run.mjs --probe ts` | `cd packages/ts && npm ci && npm test` |
| Python | `node packages/spec/runner/run.mjs --probe py` | `cd packages/py && pip install -e ".[dev]" && pytest` |
| Go | `node packages/spec/runner/run.mjs --probe golang` | `cd packages/golang && go test ./...` |
| Java | `node packages/spec/runner/run.mjs --probe java` | `cd packages/java && ./gradlew test` |
| Rust | `node packages/spec/runner/run.mjs --probe rust` | `cd packages/rust && cargo test --all-features` |

And the harness itself, which gates everything in CI:

```
node --test packages/spec/runner/run.test.mjs
node packages/spec/runner/run.mjs --probe-path packages/spec/runner/reference          # must pass
node packages/spec/runner/run.mjs --probe-path packages/spec/runner/reference/broken   # must fail
```

Each language's own test command already runs its conformance suite, so the two columns overlap
deliberately: a conformance regression fails the package's tests, not only CI.

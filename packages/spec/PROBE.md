# The Probe Contract

**Status:** normative. Companion to [`SPEC.md`](SPEC.md). RFC 2119 keywords apply as there.

One conformance runner has to drive five implementations written in five languages, built with
five toolchains. The only interface all of them share is a process: arguments in, bytes out, an
exit code. This document pins that interface. It names no runtime, no build tool, and no file
extension, and it never will — how a probe comes to exist is entirely its own package's
business.

---

## 1. Location and invocation

A conforming language package MUST provide an executable at:

```
packages/<lang>/conformance/run
```

Requirements:

- The executable bit MUST be set. The runner spawns the path directly and does not guess an
  interpreter.
- It MUST be spawnable with `packages/<lang>/` as the working directory, and MUST NOT depend on
  being spawned from anywhere else.
- It MAY be a thin launcher that compiles or resolves dependencies on first use. It SHOULD NOT
  rebuild on every invocation; the runner spawns it once per fixture, and there are many
  fixtures.
- Its own implementation language is unconstrained. A probe for a compiled language is usually a
  launcher that execs a prebuilt binary.

The runner MUST NOT be taught anything language-specific. If a package needs a build before its
probe works, that build belongs in the package's own documentation and CI step, not in the
runner.

---

## 2. Flags

Six flags. Unrecognized flags MUST cause exit 2.

| Flag | Required | Meaning |
| --- | --- | --- |
| `--package-name <name>` | yes | The package name passed through to `load`. |
| `--cwd <abs-path>` | yes | The directory discovery starts from. The probe MUST treat this as the working directory for the upward walk, whether or not the process actually changes directory. |
| `--home <abs-path>` | yes | The directory §2.4 resolves the user-level root under. The probe MUST NOT read the real home directory. |
| `--env KEY=VALUE` | no, repeatable | The complete environment for the prefixed env-var layer. |
| `--options <json>` | no, default `{}` | The options object from SPEC §6, as one JSON document. |
| `--fixture-root <abs-path>` | yes | Paths in `sources` are emitted relative to this directory. |

`--cwd` and `--home` are absolute paths and MUST be used verbatim. A probe that resolves them
against its own working directory will pass on one machine and fail on another.

`--options` carries the SPEC §6 object, e.g. `{"arrayMerge":"concat"}`. An option the probe does
not support MUST cause exit 2 with a diagnostic, not a silent pass — a probe that ignores
`arrayMerge` and still prints a result is claiming conformance it does not have.

`--fixture-root` exists so output is machine-comparable. Every `path` in `sources` MUST be
emitted relative to it, using forward slashes on every platform, with no leading `./`. Paths
that fall outside the fixture root MUST be emitted absolute; no fixture produces one, so this is
a diagnostic case rather than a normal one.

---

## 3. Environment isolation

`--env` **fully replaces** the environment for the prefixed env-var layer of SPEC §4.5. The probe
MUST consider only the pairs given on the command line, and MUST NOT read the ambient process
environment for that layer.

The trap this closes: a developer with `MYTOOL_LOG__LEVEL` exported in their shell would
otherwise see fixtures pass or fail depending on which terminal they ran them in, and the failure
would not reproduce in CI. Conformance results must be a property of the tree, not of the
operator.

Two consequences worth stating separately:

- A fixture with no `--env` flags MUST behave as if the environment held no prefixed variables at
  all, even when the real environment holds several.
- `$XDG_CONFIG_HOME` reaches the probe through `--env`, not through the ambient environment. It
  is an input to §2.4 like any other variable, and it is subject to the same replacement rule.

A probe MAY read the ambient environment for unrelated purposes — locating its own runtime,
proxy settings for a package fetch. It MUST NOT let any of that reach `load`.

---

## 4. Output

**stdout carries exactly one JSON document and nothing else.** No banner, no progress, no
trailing log line, no shell trace. The runner parses stdout whole; anything else is a protocol
failure, reported distinctly from a wrong result, because the two have completely different
causes.

All diagnostics — warnings from SPEC §2.4, §4.2, and §5, build chatter, deprecation notices —
MUST go to stderr. The runner captures stderr separately and shows it only when a fixture fails.

On success, the document is the SPEC §7 output contract:

```json
{
  "config": { },
  "found": true,
  "sources": [
    { "path": "…", "format": "…", "precedence": 0, "keys": [] }
  ]
}
```

On a load error, the document is:

```json
{ "error": { "kind": "malformed", "path": "project/.config/mytool/config.toml" } }
```

`kind` MUST be one of the closed list in SPEC §5. `path` MUST be fixture-root-relative and MUST
be omitted when the error has no path. A `message` field MAY be included and MUST NOT be compared
by the runner.

The probe SHOULD emit the canonical serialization described in [`CANONICAL.md`](CANONICAL.md),
but it is not required to: the runner canonicalizes both sides before diffing. Emitting valid
JSON is the requirement; emitting pretty JSON is a courtesy.

---

## 5. Exit codes

| Code | Meaning |
| --- | --- |
| `0` | A result document was emitted successfully. |
| `1` | The library rejected the input. An error document was emitted on stdout. |
| `2` | The probe itself could not run: bad flags, a build failure, a missing dependency, an unsupported option, a crash. |

The distinction between 1 and 2 is the whole point of having three codes. **Exit 1 means the
library did its job** — it was handed a malformed file and refused it, and that is a passing
result for an error fixture. **Exit 2 means the harness is broken** and the fixture result is
unknown; the runner reports it as an error rather than a failure and does not count it as
evidence either way.

A probe MUST NOT use exit 1 for an internal crash, and MUST NOT use exit 2 for a config file it
correctly rejected.

No other exit code is defined. The runner treats anything above 2 as if it were 2.

---

## 6. Worked example

Given a fixture at `packages/spec/fixtures/env-var-beats-files/`, the runner invokes:

```
packages/<lang>/conformance/run \
  --package-name mytool \
  --cwd         /abs/packages/spec/fixtures/env-var-beats-files/tree/project \
  --home        /abs/packages/spec/fixtures/env-var-beats-files/tree/home \
  --fixture-root /abs/packages/spec/fixtures/env-var-beats-files/tree \
  --env MYTOOL_LOG__LEVEL=trace \
  --env MYTOOL_PORT=5432 \
  --options {}
```

and requires exit 0 with this on stdout:

```json
{
  "config": {
    "log": { "level": "trace" },
    "port": 5432
  },
  "found": true,
  "sources": [
    { "format": "toml", "keys": ["log"], "path": "home/.config/mytool/config.toml", "precedence": 1 },
    { "format": "toml", "keys": ["log"], "path": "project/.config/mytool/config.toml", "precedence": 2 },
    { "format": "dotenv", "keys": ["log"], "path": "project/.config/mytool/.env", "precedence": 3 },
    { "format": "env", "keys": ["log", "port"], "path": "<env>", "precedence": 4 }
  ]
}
```

Note `"port": 5432` unquoted, and the losing layers still present in `sources`.

---

## 7. Checklist for a new probe

- [ ] `packages/<lang>/conformance/run` exists and is executable.
- [ ] All six flags parse; an unknown flag exits 2.
- [ ] `--cwd` and `--home` are honored; the real home is never read.
- [ ] Only `--env` pairs reach the prefixed env-var layer.
- [ ] stdout is one JSON document; every diagnostic goes to stderr.
- [ ] `sources` paths are relative to `--fixture-root`, forward-slashed.
- [ ] Exit 0 / 1 / 2 mean result / rejected input / broken harness.
- [ ] An unsupported option exits 2 instead of being ignored.

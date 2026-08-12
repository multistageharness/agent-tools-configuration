# agent-tools-configuration

Five language packages that load a program's configuration from `./.config/<packageName>/`,
walking up from the working directory, with a fallback to `~/.config/<packageName>/`, layered so
project-local values win — and one shared conformance suite that proves the five behave
identically.

```
./test.sh          # every package's tests, plus the conformance suite, in one table
```

| Where | What |
| --- | --- |
| [`packages/`](packages/README.md) | The five packages — `ts`, `py`, `golang`, `java`, `rust` — and the support matrix. |
| [`packages/spec/`](packages/spec/SPEC.md) | The normative specification, the fixture suite, and the runner that drives all five. |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | For someone configuring a tool: where to put the file, and how the layers combine. |
| [`docs/VERSIONING.md`](docs/VERSIONING.md) | How five independently versioned packages stay tied to one spec version. |

The claim is that the five agree. `node packages/spec/runner/run.mjs --probe <lang>` is what
turns that from a claim into a test result.

# Conformance Fixtures

Each subdirectory here is one conformance case: a synthetic filesystem, the inputs to `load`, and
the output every implementation must produce. The suite is the only thing that makes "all five
languages behave the same" a test result instead of a claim.

Behavior comes from [`../SPEC.md`](../SPEC.md). Output formatting comes from
[`../CANONICAL.md`](../CANONICAL.md). How a probe is invoked comes from
[`../PROBE.md`](../PROBE.md). Nothing is defined here that is defined there.

---

## Shape

```
<case-name>/
  manifest.json      # inputs
  expected.json      # canonical required output
  tree/
    project/…        # the synthetic working directory and its ancestors
    home/…           # the synthetic home directory
```

All four paths are required. A case without an `expected.json` is not a case.

**Hermeticity is the rule.** A fixture carries its own project tree and its own home directory
and never touches the real ones. No fixture may contain an absolute path, a reference to `$HOME`,
or anything that resolves differently on two machines. `tree/` is the entire world the case runs
in.

---

## How the runner maps a fixture onto a probe

For a fixture at `packages/spec/fixtures/<case-name>/`, the runner spawns the probe with:

| Flag | Value |
| --- | --- |
| `--package-name` | `manifest.packageName` |
| `--cwd` | `<abs>/<case-name>/tree/<manifest.cwd>` |
| `--home` | `<abs>/<case-name>/tree/<manifest.home>` |
| `--fixture-root` | `<abs>/<case-name>/tree` |
| `--env` | one flag per entry in `manifest.env` |
| `--options` | `manifest.options` as JSON |

Two things follow from that table:

- `manifest.cwd` may point at a **nested** directory — `project/a/b` — which is how the upward
  walk gets exercised. It is relative to `tree/`, not to the case directory.
- Because `--fixture-root` is `tree/`, every path in `expected.json` is written relative to
  `tree/`: `project/.config/mytool/config.toml`, `home/.config/mytool/config.toml`.

### `${TREE}` in `manifest.env`

Some cases need an environment variable holding an absolute path — `XDG_CONFIG_HOME` is the only
one today. Writing an absolute path into a fixture is forbidden, so manifests use the token
`${TREE}`, which the runner replaces with the absolute path of that fixture's `tree/` directory
before spawning:

```json
"env": { "XDG_CONFIG_HOME": "${TREE}/home/xdg" }
```

`${TREE}` is the only token the runner expands, and it is expanded only inside `env` values.

### `dot-git` markers

SPEC §2.3 stops the upward walk at a directory containing an entry named `.git`. Every fixture
needs that stop condition, or its walk escapes `tree/` and climbs into the real repository — the
opposite of hermetic.

Git will not track a path with a `.git` component, so fixtures record the marker as a regular
file named **`dot-git`**. Before running a case, the runner materializes an empty `.git` file
beside every `dot-git` it finds under `tree/`, and removes it afterward in a `finally`. Probes
never see `dot-git`; they see `.git`, exactly as SPEC §2.3 describes.

Put a `dot-git` at the top of every case's `project/` tree unless the case is specifically about
what happens without one.

### Permission cases

A case asserting `unreadable` cannot rely on a checkout preserving mode `000` — many do not, and
a file nobody can read is hostile to tooling anyway. The fixture is committed readable, and the
runner chmods the target to `000` before the case and restores the original mode afterward in a
`finally`, so an aborted run cannot leave an unreadable file in the working tree. Such a case
MUST also set `skipOn: ["win32"]`, because Windows cannot express the mode.

**A case that can skip is a case that can hide a defect.** `unreadable-permissions` skips
wherever an ACL or a privileged user overrides the mode, and that skip once let an
implementation swallow unreadable files while reporting every runnable fixture green. Its
portable sibling `unreadable-directory` asserts the same clause with a *directory* named
`config.toml` — every implementation reports `EISDIR` as `unreadable`, and no permission bits
are involved. When adding a case that needs `skipOn`, ask whether a portable sibling can assert
the same clause; see `changelogs/` record 0001.

---

## Naming

Case directories are kebab-case and name the **behavior asserted**, not a number:
`both-array-replace`, `stop-at-git-root`, `env-var-beats-files`. Never `case-07`. A failing case
name should tell a reader what broke before they open anything.

Sibling cases that isolate a single variable share a tree and differ in one manifest field —
`both-array-replace` and `both-array-concat` are the same tree with a different
`options.arrayMerge`. Keep that property when adding cases: a failure that isolates one option is
worth several that do not.

---

## Deriving `expected.json`

A fixture MUST be **hand-derived from `SPEC.md`** — read the clause, walk the tree by hand, write
the output. It MUST NOT be produced by running an implementation and recording what came out;
that makes the suite a regression test for one implementation's bugs rather than a conformance
test against the spec.

Every manifest MUST record the clause it was derived from in `manifest.specClause`, as a bare
section number: `"2.5"`, `"4.3"`, `"3.2"`. When a case fails, that is where the reader goes.

---

## How to add a fixture

1. Create the directory: `packages/spec/fixtures/<case-name>/`.
2. Write `manifest.json`. It must validate against
   [`manifest.schema.json`](manifest.schema.json) — `name` must equal the directory name, and
   `additionalProperties` is `false`, so a typo in a field name is a schema error rather than a
   mystery.
3. Build `tree/`: `tree/project/…` and `tree/home/…`, plus a `dot-git` marker where the walk
   should stop. Use `.gitkeep` to commit an otherwise empty directory.
4. Hand-compute `expected.json` from the spec clause, in the canonical form
   ([`../CANONICAL.md`](../CANONICAL.md)).
5. Confirm the runner sees it:

   ```
   node packages/spec/runner/run.mjs --list
   ```

6. Confirm it is right by running it against the reference probe, which implements the spec
   naively and exists for exactly this purpose:

   ```
   node packages/spec/runner/run.mjs --probe-path packages/spec/runner/reference --fixture <case-name>
   ```

   If the reference probe disagrees with a hand-derived expectation, one of the two is wrong and
   finding out which is the point of the exercise.

---

## Case index

| Case | Asserts | Spec |
| --- | --- | --- |
| `local-only` | A project-local config alone is found. | §2.2 |
| `user-only` | A user-level config alone is found. | §2.4 |
| `neither-present` | No config is not an error. | §5 |
| `ancestor-two-levels-up` | The walk climbs to a grandparent. | §2.2 |
| `stop-at-git-root` | The walk stops at a `.git` boundary. | §2.3 |
| `xdg-config-home-set` | `$XDG_CONFIG_HOME` replaces `~/.config`, and the default is not also read. | §2.4 |
| `both-scalar-conflict` | Project beats user; the loser is still in `sources`. | §3.1 |
| `both-nested-map-merge` | Maps deep-merge instead of replacing. | §4.1 |
| `both-array-replace` | Arrays replace by default. | §4.3 |
| `both-array-concat` | `arrayMerge: "concat"` appends and does not dedupe. | §4.3 |
| `explicit-null-unsets` | An explicit null deletes the key. | §4.4 |
| `dotenv-overlay` | `.env` overlays the structured files in its own root. | §2.5 |
| `env-var-beats-files` | Env beats every file, `__` nests, and `5432` is a number. | §4.5 |
| `same-dir-format-precedence` | Several formats in one directory all load, last-listed wins. | §2.5 |
| `first-match-strategy` | `first-match` suppresses the lower root entirely. | §3.2 |
| `malformed-toml` | A broken file is an error, not a silent fallback. | §5 |
| `duplicate-yaml-extension` | `.yaml` beside `.yml` is an error. | §2.5 |
| `unreadable-permissions` | An unreadable file is an error naming the path. | §5 |
| `unreadable-directory` | The same clause, expressed without permission bits so it runs everywhere. | §5 |

# Polyglot Configuration Discovery — Normative Specification

**Status:** normative. **Version:** 1.0.0.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this document are to be
interpreted as described in RFC 2119. A sentence without one of those words is explanatory and
carries no requirement.

An implementation conforms when it satisfies every MUST in this document and passes the fixture
suite in [`fixtures/`](fixtures/) via the probe contract in [`PROBE.md`](PROBE.md). Conformance
is a test result, not a claim.

---

## 1. Terminology

**package name** — the identifier a calling program passes to `load`. It names the directory
searched for inside `.config/`, and it seeds the default environment-variable prefix. It MUST be
treated as a single path segment: an implementation MUST reject a package name containing a path
separator, `.`, or `..`.

**config directory** — a directory holding one or more *recognized files* (§2.5). Two kinds
exist, distinguished only by where they were found.

**project-local root** — a directory `<dir>/.config/<packageName>/` discovered by the upward
walk (§2.2). There MAY be several; they are ordered farthest-ancestor first.

**user-level root** — the single directory resolved by §2.4, normally
`~/.config/<packageName>/`.

**layer** — one of the six numbered precedence classes in §3. A layer is a *class* of input
(built-in defaults, user files, project files, `.env`, environment variables, programmatic
overrides), not an individual file.

**source** — one concrete contributing input: a single file, or the whole of the defaults, env,
or overrides layer. Every source that was read MUST appear in the `sources` output (§7), whether
or not any of its values survived the merge.

**probe** — a per-language executable that exposes `load` to the conformance runner over a
process boundary. Its contract is [`PROBE.md`](PROBE.md).

---

## 2. Search-Path Resolution

### 2.1 Inputs

Resolution takes the package name, plus these options (full list in §6): `cwd`, `home`,
`stopDir`, `profile`. Implementations MUST accept `cwd` and `home` as caller-supplied overrides
and MUST use them in place of the process working directory and the platform home directory
when they are given. Without that, the behavior is untestable.

`cwd` MUST be realpath-resolved exactly once, before the walk begins.

### 2.2 The upward walk

Let `<dir>` be the realpath-resolved `cwd`. Then:

1. Start at `<dir>`.
2. If `<dir>/.config/<packageName>/` exists and is a directory, record it as a project-local
   root.
3. Evaluate the stop conditions of §2.3 against `<dir>`. If any holds, end the walk.
4. Otherwise set `<dir>` to the parent of `<dir>` and go to step 2.

The order matters: a directory is always *checked* before it is *tested for stopping*. A
`.config/<packageName>/` sitting beside a `.git` directory MUST be found, and the walk MUST then
stop there.

The walk MUST collect **all** matching ancestors, nearest last, not only the first. §2.7 gives
the resulting order and §3 applies them nearest-wins.

Rationale for collect-all: a package inside a monorepo inheriting the repository root's settings
and overriding two of them is the common case, and stop-at-first cannot express it. Callers who
want the pure fallback reading — the nearest root and nothing below it — set
`strategy: "first-match"` (§3.2), which recovers that behavior without a second walk.

A directory that exists but is not readable MUST NOT end the walk; it is skipped, and
implementations SHOULD emit a diagnostic. A `.config/<packageName>` that exists but is a
*regular file* MUST be ignored, and the walk continues.

### 2.3 Stop conditions

| Condition | Default or opt-in | Meaning |
| --- | --- | --- |
| Filesystem root | default | `<dir>` has no parent, or is its own parent. |
| Home directory | default | `<dir>` is the resolved home (§2.4). Inclusive: home is checked for a config directory in step 2, and the walk ends after that check. |
| Repository boundary | default | `<dir>` contains an entry named `.git`. |
| `stopDir` | opt-in | `<dir>` is the realpath-resolved `stopDir`. Inclusive, exactly like home. |

The repository boundary MUST test for the *presence of an entry* named `.git`, whether it is a
directory or a regular file. A file is how `git` records a linked worktree and a submodule, and
those are repositories too.

Implementations MUST NOT walk above the resolved home directory by default. `stopDir` MAY be set
to an ancestor of home to widen the walk, and when both apply, the walk ends at whichever is
reached first.

`stopDir` MUST be checked before the walk moves past it, i.e. it is evaluated in step 3 like
every other condition, so the `stopDir` directory itself is searched.

### 2.4 User-level root

1. If `$XDG_CONFIG_HOME` is set **and** its value is an absolute path, the user-level root MUST
   be `$XDG_CONFIG_HOME/<packageName>/`. Note the absence of `.config` in that form — the
   variable already names a config home.
2. If `$XDG_CONFIG_HOME` is set but empty, or set to a relative path, implementations MUST
   ignore it and MUST emit a warning on the diagnostic channel naming the variable and its
   value. `XDG_CONFIG_HOME=../cfg` therefore behaves exactly as if the variable were unset,
   plus a warning. Silently resolving a relative XDG path against the working directory would
   make the user-level root move as the caller chdirs, which is the one thing a user-level root
   must not do.
3. Otherwise the user-level root MUST be `<home>/.config/<packageName>/`, where `<home>` is the
   `home` option when the caller supplies one and the platform home directory otherwise.

There is exactly one user-level root. It is not walked upward from and it is not searched for.

**Windows.** The rules above apply unchanged. `%APPDATA%` and `%LOCALAPPDATA%` MUST NOT be
consulted, and `%USERPROFILE%\.config\<packageName>\` is the user-level root on Windows.
Rationale: one documented path that is identical on every platform is worth more here than a
platform-native path, because the same `<packageName>` config is expected to be readable by five
different language implementations, possibly on three operating systems, and every deviation
multiplies across that matrix. Users who want the native location can point `$XDG_CONFIG_HOME`
at it.

**Symlinks.** `cwd` is realpath-resolved once (§2.1) and the walk then follows the *physical*
parent chain. A project directory reached through a symlink therefore searches the ancestors of
its real location, not of the link. The consequence: `/tmp/link -> /srv/repo/pkg` searches
`/srv/repo` and not `/tmp`. The user-level root is not realpath-resolved; it is used as
constructed, so a symlinked `~/.config` works as expected.

### 2.5 Recognized files

Within a single config directory, exactly these file names are recognized, in this order:

1. `config.toml`
2. `config.yaml`
3. `config.yml`
4. `config.json`
5. `config.jsonc`
6. `config.ini`
7. `.env`

The list is **closed**. Implementations MUST NOT recognize any other name or extension, and MUST
NOT make the list extensible through options. An open list cannot be implemented identically in
five ecosystems, because the five ship different parsers.

Every recognized file present in a directory MUST be loaded. They layer within that directory in
the order listed, with **later entries winning**, so `.env` overlays the structured formats and
`config.json` overrides `config.toml`. A file that is present but parses to an empty document
MUST still be loaded and MUST still appear in `sources` (§7).

`config.ini` is an untyped format: every value in it is text as far as the format is concerned.
Implementations MUST type INI values by the §4.5 step 5 rule — parse as JSON, keep the raw
string when that fails — so `port=5432` is the number in an INI file exactly as it is in the
environment.

`config.yaml` and `config.yml` in the same directory MUST be an error of kind
`duplicate-format` (§5). It is a mistake, not an intention, and picking a winner silently would
hide it. No other pair of recognized names collides in this way.

### 2.6 Profiles (MAY)

Implementations MAY support a `profile` option. When they do, and a profile is active, the file
`config.<profile>.<ext>` MUST be loaded immediately after its base `config.<ext>`, within the
same directory block and for each recognized extension in the §2.5 order. `.env.<profile>`
follows `.env` on the same rule.

This entire subsection is optional. An implementation that ignores `profile` still conforms, and
MUST report the option as unsupported on the diagnostic channel rather than accepting it
silently. No conformance fixture depends on profiles.

### 2.7 Resolved root ordering

The resolved roots MUST be ordered lowest priority first:

1. the user-level root (§2.4), if it exists;
2. the project-local roots (§2.2), farthest ancestor first, nearest last.

The nearest project-local root is therefore last and wins. §3 applies this ordering.

---

## 3. Layer Precedence

### 3.1 The table

Lowest to highest:

| # | Layer | Source |
| --- | --- | --- |
| 0 | Built-in defaults | supplied by the calling program |
| 1 | User-level directory files | `<user-root>/config.*` in the §2.5 order |
| 2 | Project-local directory files | ancestor roots, farthest first, nearest last |
| 3 | `.env` files | at each root, applied within that root's block |
| 4 | Prefixed environment variables | `<PREFIX>_…` from the process environment |
| 5 | Explicit programmatic overrides | passed to `load` by the caller |

Layer 3 is a per-root overlay, not a global one: a root's `.env` is applied at the end of *that
root's* block, immediately after that root's structured files. A user-level `.env` therefore
loses to a project-local `config.toml`, which is the only sane reading — a file in the user's
home must not outrank a file committed to the project.

The full application order is: layer 0; then each root in §2.7 order, its structured files in
§2.5 order followed by its `.env`; then layer 4; then layer 5.

Implementations MUST emit `sources` in that application order (§7), which is ascending
`precedence` except that a `.env` entry sits inside its own root's block.

### 3.2 `strategy`

`strategy: "layered"` (the default) — every resolved root contributes, per the table above.

`strategy: "first-match"` — only the highest-precedence root that contained at least one
recognized file contributes. Lower roots MUST NOT be read and MUST NOT appear in `sources`.
Layers 0, 4, and 5 still apply exactly as before; the option scopes only the file layers.

`first-match` is the literal "load from the project, else fall back to the user level" reading.
It is offered because that reading is a legitimate design, not because layering is in doubt.

### 3.3 Worked example

Package `mytool`. Three inputs:

| Where | Value |
| --- | --- |
| `~/.config/mytool/config.toml` | `log.level = "info"` |
| `<project>/.config/mytool/config.toml` | `log.level = "debug"` |
| environment | `MYTOOL_LOG__LEVEL=trace` |

Result: `config.log.level` is **`"trace"`**. Layer 4 outranks layer 2, which outranks layer 1.

`sources`, in application order:

```json
[
  { "path": "/home/u/.config/mytool/config.toml", "format": "toml", "precedence": 1, "keys": ["log"] },
  { "path": "/project/.config/mytool/config.toml", "format": "toml", "precedence": 2, "keys": ["log"] },
  { "path": "<env>", "format": "env", "precedence": 4, "keys": ["log"] }
]
```

Both losing layers are still listed. That is the point of `sources`: the user who expected
`debug` needs to see that something above it set the key.

---

## 4. Merge Semantics

Merging is pairwise and left-to-right over the application order of §3.1: the accumulated result
so far is the *lower* layer and the incoming source is the *higher* layer.

### 4.1 Maps

Maps MUST deep-merge key by key. A key present in only one of the two layers MUST survive
unchanged. A key present in both, with a map on each side, MUST be merged recursively.

### 4.2 Type conflicts

A key whose value is a map in the lower layer and a scalar (or array) in the higher layer MUST be
**replaced** by the higher layer's value, and implementations SHOULD warn, naming the key path.
The reverse — scalar below, map above — MUST likewise be replaced by the map, with the same
SHOULD-warn. Replacement is chosen over an error because the higher layer is the more specific
statement of intent, and because five parsers infer types differently enough that a hard error
here would fail on file format rather than on user mistake.

### 4.3 Arrays

Arrays MUST be **replaced** wholesale by default: the higher layer's array is the result, and the
lower layer's elements are discarded. Element-wise merging by index is never performed.

`arrayMerge: "concat"` is an opt-in alternative. It MUST append the higher layer's elements onto
the lower layer's, in that order, and it MUST NOT deduplicate. `["a","b"]` under `["c"]` yields
`["a","b","c"]`, and `["a"]` under `["a"]` yields `["a","a"]`.

The option is global to a `load` call. Per-key array strategies are out of scope.

### 4.4 Null and absence

An explicit null in a higher layer MUST remove the key from the merged result. The result MUST
NOT contain the key with a null value.

Absent is not null. A key a higher layer never mentions MUST be left alone; a key a higher layer
sets to null MUST be deleted. Every merge rule in this section depends on that distinction.

TOML has no null literal, so a TOML file cannot unset a key. That is a limitation of the format,
not of this specification; use `config.json` or an environment variable for the unset. Where a
format cannot express null, implementations MUST NOT invent a sentinel string (`"null"`,
`"~"`, `""`) that means null — the string means the string.

In `.env` files and environment variables, the *unquoted* value `null` parses as JSON null and
therefore unsets (§4.5). `MYTOOL_PROXY__URL=null` removes `proxy.url`.

### 4.5 Environment variables

The layer-4 mapping, from variable name to key path:

1. Consider only variables whose name begins with `<PREFIX>_`, where `<PREFIX>` is the
   `envPrefix` option, defaulting to the package name uppercased with every character outside
   `[A-Z0-9]` replaced by `_`.
2. Strip that `<PREFIX>_`.
3. Lowercase the remainder.
4. Split on `__` (two underscores) to produce the key path. A single `_` is a literal character
   in a key name and MUST NOT split.
5. Coerce the value: parse it as JSON; if it parses, use the parsed value; if it does not, use
   the raw string.

So with prefix `MYTOOL`:

| Variable | Key path | Value | Type |
| --- | --- | --- | --- |
| `MYTOOL_PORT=5432` | `port` | `5432` | number |
| `MYTOOL_NAME=5432abc` | `name` | `"5432abc"` | string |
| `MYTOOL_LOG__LEVEL=trace` | `log.level` | `"trace"` | string |
| `MYTOOL_MAX_RETRIES=3` | `max_retries` | `3` | number |
| `MYTOOL_DEBUG=true` | `debug` | `true` | boolean |
| `MYTOOL_TAGS=["a","b"]` | `tags` | `["a","b"]` | array |

The coercion rule is stated as *parse-as-JSON-or-keep-the-string* precisely because the wrapped
libraries disagree here: some coerce everything to strings, some guess with their own grammar.
JSON is the one grammar all five ecosystems already have.

Implementations MUST ignore a variable whose name is exactly `<PREFIX>_` or that maps to an empty
key path, and SHOULD warn.

### 4.6 `.env` files

A `.env` file is a flat list of `KEY=VALUE` lines. Blank lines and lines whose first
non-whitespace character is `#` MUST be ignored. A leading `export ` MUST be stripped. Values MAY
be wrapped in matching single or double quotes, which MUST be removed; an unquoted value MUST be
trimmed of surrounding whitespace.

Key names map to key paths by §4.5 steps 2–4, with one relaxation: the `<PREFIX>_` prefix is
stripped when present and simply absent otherwise. A `.env` inside `.config/<packageName>/` is
already unambiguous about which package it belongs to, so `LOG__LEVEL=trace` and
`MYTOOL_LOG__LEVEL=trace` mean the same thing there.

Value coercion is §4.5 step 5, except that a value which was written inside quotes MUST remain a
string. `PORT="5432"` is the string, `PORT=5432` is the number.

---

## 5. Errors

Every error raised by `load` MUST carry a machine-readable `kind` drawn from this closed list.
Fixtures assert on `kind` and `path`; they MUST NOT assert on message text, which is expected to
differ across parsers and languages.

| `kind` | Trigger | Required behavior |
| --- | --- | --- |
| `not-found` | No recognized file at any resolved root. | **Not an error.** `load` MUST succeed, returning the defaults layer with `found: false` and an empty `sources`. The `kind` exists so callers can name the condition. |
| `unreadable` | A recognized file exists but cannot be read — permissions, or an I/O failure. | Error. The message MUST name the path. |
| `malformed` | The parser rejected the file. | Error. The message MUST name the path, and SHOULD name the line and column when the underlying parser reports them. |
| `duplicate-format` | `config.yaml` and `config.yml` in one directory (§2.5). | Error. The message MUST name the directory. |
| `unknown-key` | A key is present that the caller's schema does not declare. | Warning by default. Error when `strict` is set. |
| `validation` | A value failed the caller's schema. | Always an error. The message MUST name the key path. |

`not-found` is not an error. A CLI with sensible defaults MUST be able to run with no config file
anywhere. The inverse is just as important: a config file that exists and is broken MUST stop the
program, because silently falling back to defaults turns a typo into a production incident.

An error MUST abort the whole `load` call. Implementations MUST NOT return a partial merge
alongside an error.

Errors are reported in each language's idiom — an exception, an `error` return, a `Result::Err`.
The requirement is only that `kind` and the path survive to the caller as structured data, not as
prose to be regex-matched.

---

## 6. Options Reference

All options are optional. The type column is language-neutral.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cwd` | path | process working directory | Where the upward walk starts (§2.2). Realpath-resolved once. |
| `home` | path | platform home directory | Overrides the home used by §2.4 and by the home stop condition (§2.3). |
| `stopDir` | path | none | Opt-in extra stop condition (§2.3). Inclusive. |
| `strategy` | `"layered" \| "first-match"` | `"layered"` | Whether every root contributes or only the nearest one with a file (§3.2). |
| `arrayMerge` | `"replace" \| "concat"` | `"replace"` | Array behavior (§4.3). |
| `envPrefix` | string | package name, uppercased, non-alphanumerics to `_` | Prefix for layer 4 (§4.5). |
| `profile` | string | none | Optional profile files (§2.6). |
| `strict` | boolean | `false` | Promotes `unknown-key` from warning to error (§5). |
| `defaults` | map | `{}` | Layer 0. |
| `overrides` | map | `{}` | Layer 5. |

An implementation MUST reject an unknown option name rather than ignoring it, and MUST reject an
option whose value is outside its documented set — `strategy: "first_match"` is an error, not a
synonym.

---

## 7. Output Contract

A successful `load` MUST return these three things, however the language spells them:

| Field | Type | Meaning |
| --- | --- | --- |
| `config` | map | The merged configuration. |
| `found` | boolean | True when at least one recognized file contributed. False when none was found anywhere, in which case `config` is the defaults layer alone. |
| `sources` | ordered array | Every source that was read, in application order (§3.1), lowest effective priority first. |

Each `sources` entry MUST have exactly these four fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The file's path — absolute at runtime; fixture-relative in probe output (see `PROBE.md`). For the non-file layers the value MUST be the literal `<defaults>`, `<env>`, or `<overrides>`. |
| `format` | string | One of `toml`, `yaml`, `json`, `jsonc`, `ini`, `dotenv`, `env`, `defaults`, `overrides`. `dotenv` is a `.env` file; `env` is the process environment. |
| `precedence` | integer | The layer number from the §3.1 table. |
| `keys` | array of string | The top-level keys this source contributed, sorted lexicographically. |

A recognized file that parsed to an **empty document** MUST still appear, with `keys: []`. "I read
it and it was empty" and "I never saw it" are different answers to a debugging question, and the
only place a user can tell them apart is here.

Layers 0, 4, and 5 MUST appear as a single entry each, and MUST be omitted entirely when they are
empty. A `sources` array is therefore never padded with three empty entries in the common case.

`found` reflects files only. A `load` that found no file but received defaults and two
environment variables returns `found: false` with a non-empty `sources` — the caller asked
whether a config file exists, and none does.

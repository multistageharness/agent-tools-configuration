# Configuring a tool

This is the document for someone who wants to configure a tool that uses `config-discovery`. It
is written once, for all five language implementations, because they behave identically — that
is the whole point of the project, and it is verified by a shared test suite rather than
asserted.

If you want the normative text, with the exact wording implementers are held to, read
[`packages/spec/SPEC.md`](../packages/spec/SPEC.md). This document deliberately uses no
requirement keywords at all; it tells you where to put your file.

---

## The short answer

Put a `config.toml` in `.config/<toolname>/` in your project:

```
myproject/
  .config/
    mytool/
      config.toml     ← here
  src/
```

Or in `~/.config/<toolname>/` to configure the tool everywhere:

```
~/.config/mytool/config.toml
```

If both exist, **both are read, and the project one wins** — key by key, so a project file that
sets one value does not throw away the rest of your personal settings.

---

## Where files are looked for

Two places.

**The project.** Starting from the directory you ran the tool in, the tool looks for
`.config/<toolname>/`. If it is not there, it looks in the parent directory, then that
directory's parent, and so on upward. Every one it finds is used, with the *nearest* winning:
a package inside a monorepo inherits the repository root's settings and can override two of
them.

The upward search stops at whichever of these comes first:

- a directory containing `.git` — so it does not wander out of your repository,
- your home directory — so it never reads someone else's project,
- the top of the filesystem.

**Your home directory.** `~/.config/<toolname>/`, or `$XDG_CONFIG_HOME/<toolname>/` when that
variable is set to an absolute path. It is not searched upward; there is exactly one.

The same paths apply on Windows: `C:\Users\you\.config\mytool\`. `%APPDATA%` is deliberately not
used, so the location is the same sentence on every platform.

---

## Which filenames count

Inside a `.config/<toolname>/` directory, these names are read, in this order:

1. `config.toml`
2. `config.yaml`
3. `config.yml`
4. `config.json`
5. `config.jsonc` — JSON with `//` and `/* */` comments
6. `config.ini`
7. `.env`

Nothing else. No `mytool.config.js`, no `.mytoolrc`, no `config.local.toml`.

**All of them are read if all of them are there**, and later entries in that list win. So a
`.env` beside a `config.toml` overrides it, and a `config.json` overrides a `config.toml`. In
practice: pick one and use it.

The one exception is `config.yaml` and `config.yml` together — that is an error, not a merge.
Having both is a mistake, and silently picking one would hide it.

---

## How the layers combine

From lowest priority to highest:

| | Layer |
| --- | --- |
| 1 | the tool's own built-in defaults |
| 2 | `~/.config/<toolname>/` |
| 3 | `.config/<toolname>/` in your project — farthest ancestor first, nearest last |
| 4 | a `.env` inside whichever of those directories it sits in |
| 5 | `MYTOOL_*` environment variables |
| 6 | anything the program passes in itself |

Combining is **key by key, all the way down**. If your home file sets `database.host` and
`database.port`, and your project file sets only `database.port`, you get your project's port
and your home file's host.

Two rules that are worth knowing before they surprise you:

- **Lists are replaced, not appended.** If your home file sets `plugins = ["a", "b"]` and your
  project sets `plugins = ["c"]`, the answer is `["c"]`. Some tools offer an option to append
  instead; ask that tool.
- **An explicit `null` removes a key.** Writing `proxy = null` in a higher-priority file deletes
  the setting rather than setting it to nothing. TOML has no `null`, so you need `config.json`
  or `config.yaml` at the overriding layer to do this.

---

## Environment variables

Any variable named after the tool, uppercased, overrides a setting:

```sh
MYTOOL_LOG__LEVEL=trace     # sets log.level
MYTOOL_PORT=5432            # sets port, as the number 5432
MYTOOL_NAME=5432abc         # sets name, as the string "5432abc"
MYTOOL_MAX_RETRIES=3        # sets max_retries - one underscore is part of the name
```

**Two underscores mean "go one level deeper".** One underscore is just a character in the key
name. That is the rule to remember: `LOG__LEVEL` is `log.level`, `MAX_RETRIES` is `max_retries`.

Values that look like JSON are read as JSON — numbers become numbers, `true` becomes a boolean,
`[1,2]` becomes a list. Anything else stays a string. If you want the *string* `5432`, most
tools accept `MYTOOL_PORT='"5432"'` with the quotes inside the value.

---

## A worked example

`~/.config/mytool/config.toml`:

```toml
[log]
level = "info"

[database]
host = "db.example.com"
port = 5432
```

`myproject/.config/mytool/config.toml`:

```toml
[log]
level = "debug"
```

And in the shell:

```sh
export MYTOOL_DATABASE__PORT=6543
```

Running the tool inside `myproject` gives:

```json
{
  "log": { "level": "debug" },
  "database": {
    "host": "db.example.com",
    "port": 6543
  }
}
```

Read that as three separate decisions: `log.level` came from the project file, which outranks
the home file. `database.host` came from the home file, because nothing else mentioned it.
`database.port` came from the environment variable, which outranks both.

*(This output is not illustrative — it is what `packages/ts` actually printed for this tree.)*

---

## When something is not what you expected

Every implementation reports the list of files it read, in the order it applied them. Most tools
expose this behind a flag such as `--config-debug`, `--show-config`, or a verbose mode; ask the
tool.

For the example above it looks like this:

```
1  /home/you/.config/mytool/config.toml   contributed: database, log
2  /myproject/.config/mytool/config.toml  contributed: log
4  <env>                                  contributed: database
```

The number is the layer, from the table above. Read it from the bottom: the **last** thing that
mentioned a key is the thing that set it. If a value is not what you expect, find the highest
numbered entry that lists its top-level key — that is the file to edit.

A file that was read but turned out to be empty still appears, with nothing listed after
"contributed". That is deliberate: "I read it and it was empty" and "I never saw it" are
different answers, and only one of them means your file is in the wrong place.

---

## Missing versus broken

**No configuration file anywhere is not an error.** The tool starts with its defaults, and can
tell you that nothing was found.

**A configuration file that exists and is broken is an error**, and the tool refuses to start.
This is deliberate: a tool that silently fell back to defaults because your YAML had a tab in it
would turn a typo into an outage.

The errors you can get:

| What happened | What you see |
| --- | --- |
| The file cannot be read — permissions | an error naming the path |
| The file does not parse | an error naming the path, and usually the line |
| `config.yaml` and `config.yml` in one directory | an error naming the directory |
| A key the tool does not recognize | a warning, or an error in strict mode |
| A value of the wrong type or out of range | an error naming the key |

---

## Notes

- **`$XDG_CONFIG_HOME`** replaces `~/.config` when it is set to an absolute path — the tool then
  looks in `$XDG_CONFIG_HOME/<toolname>/` and does *not* also look in `~/.config`. A relative
  value is ignored, with a warning, because a config location that moved when you changed
  directory would be worse than no config.
- **Profiles.** Some implementations support `config.<profile>.toml` beside `config.toml`,
  loaded straight after it. This is optional; check the tool.
- **Per-language usage** — installing, calling, and the API — is in each package's README under
  [`packages/`](../packages/README.md).

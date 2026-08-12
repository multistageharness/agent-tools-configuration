# `configdiscovery` (Go)

Load a program's configuration from `./.config/<packageName>/` — walking up from the working
directory — with a fallback to `~/.config/<packageName>/`, layered so project-local values win.

Implements the shared cross-language contract in [`../spec/SPEC.md`](../spec/SPEC.md).

**Conformance: passing** — 18 of 19 fixtures pass and 1 skips on macOS, where an inherited ACL
under `/Users/Shared` means `chmod 000` cannot make a file unreadable. That case runs on Linux.
Verify with `node ../spec/runner/run.mjs --probe golang`.

Implements **SPEC 1.0.0** ([`../spec/SPEC.md`](../spec/SPEC.md)). Last conformance run: **2026-08-11**.

## Install

```sh
go get github.com/multistageharness/agent-tools-configuration/packages/golang
```

## Quickstart

```go
import configdiscovery "github.com/multistageharness/agent-tools-configuration/packages/golang"

result, err := configdiscovery.Load("mytool")
if err != nil {
    return err
}
if !result.Found {
    log.Println("no config file found; using defaults")
}
for _, source := range result.Sources {
    log.Println(source.Precedence, source.Path)
}
```

`result.Config` is a `map[string]any`. For a struct, use `Unmarshal`:

```go
type Settings struct {
    LogLevel string `mapstructure:"logLevel"`
    Port     int    `mapstructure:"port"`
}

var settings Settings
if err := result.Unmarshal(&settings); err != nil {
    return err
}
```

`Unmarshal` does **not** weakly coerce: a string where an int belongs is an error. The spec
already coerced at load time, and coercing a second time would hide the bug rather than surface
it. `UnmarshalStrict()` additionally reports a key with nowhere to go as `KindUnknownKey`.

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

`WithStrategy`, `WithArrayMerge`, `WithStopDir`, `WithEnvPrefix`, `WithProfile`, `WithStrict`,
`WithHome`, `WithCwd`, `WithEnv`, `WithDefaults`, `WithOverrides`, `WithRelativeTo`,
`WithWarningHandler`.

`WithCwd`, `WithHome`, and `WithEnv` replace the only three ambient inputs `Load` reads. That is
what makes the conformance probe and every test in this package hermetic.

## Environment variables

```
MYTOOL_LOG__LEVEL=trace   ->  {"log": {"level": "trace"}}
MYTOOL_PORT=5432          ->  {"port": int64(5432)}
MYTOOL_NAME=5432abc       ->  {"name": "5432abc"}
MYTOOL_SOME_KEY=1         ->  {"some_key": int64(1)}   // one underscore is literal
```

`__` splits nesting levels. Values are parsed as JSON when they parse and kept as strings when
they do not.

Every source is normalized to one numeric representation — `int64` for an integral value,
`float64` otherwise — so a `5432` from a TOML file and a `5432` from an environment variable are
`reflect.DeepEqual`. Without that the parsers disagree by construction: go-toml yields `int64`
and `encoding/json` yields `float64` for everything.

## Errors

Nothing found is **not** an error: you get `Found: false` and a nil error. A file that exists and
is broken **is** an error, because silently falling back to defaults when a YAML file has a tab
in it turns a typo into an incident.

```go
if configdiscovery.IsKind(err, configdiscovery.KindMalformed) { … }

var configError *configdiscovery.ConfigError
if errors.As(err, &configError) {
    log.Println(configError.Kind, configError.Path, configError.Line)
}
```

`Kind` is one of `KindNotFound`, `KindUnreadable`, `KindMalformed`, `KindDuplicateFormat`,
`KindUnknownKey`, `KindValidation`. Branch on it; never match the message text.

## What Viper does here, and what it does not

**Viper lowercases every key, at every depth.** `viper.AllSettings()` on a file containing
`logLevel` under `[Nested]` returns `nested.loglevel`. The spec is case-sensitive, so routing
values through Viper's key store would destroy information before the merge ever ran.

So the key store is bypassed for loading. Files are parsed by the parsers Viper itself uses —
`pelletier/go-toml/v2`, `yaml.v3`, `ini.v1` — imported directly and decoded straight into
`map[string]any`, plus `encoding/json` and `godotenv`. The per-format decision is recorded at the
top of [`loaders.go`](loaders.go).

Viper is still load-bearing: it is what `Unmarshal` uses to bind the merged map onto a struct,
where its case-insensitive matching is a feature rather than a defect. `AutomaticEnv` and
`SetEnvPrefix` are likewise not used — see the header of [`env.go`](env.go) — because Viper defers
coercion to read time and reads the process environment directly.

No exported identifier in this package references any of that; the libraries are an
implementation detail.

## Development

```sh
go test ./...        # unit tests plus the cross-language conformance suite
go test -race ./...
go vet ./... && gofmt -l .
```

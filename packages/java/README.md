# `config-discovery` (Java)

Load a program's configuration from `./.config/<packageName>/` — walking up from the working
directory — with a fallback to `~/.config/<packageName>/`, layered so project-local values win.

Two modules:

| Module | Coordinates | What it is |
| --- | --- | --- |
| `core` | `io.github.multistageharness:config-discovery-core` | The whole spec, with **no Spring on the classpath**. Jackson-based. |
| `spring` | `io.github.multistageharness:config-discovery-spring` | An optional Spring Boot adapter. See [`spring/README.md`](spring/README.md). |

The Java **package** is `dev.configdiscovery`; the Maven **groupId** is
`io.github.multistageharness`. They differ on purpose: Maven Central verifies namespace
ownership, and a `dev.*` groupId would need the `configdiscovery.dev` domain, while the
`io.github.*` one needs only the GitHub account that already exists. See
[`RELEASE.md`](RELEASE.md). Implements the shared cross-language contract in
[`../spec/SPEC.md`](../spec/SPEC.md).

**Conformance: passing** — 18 of 19 fixtures pass and 1 skips on macOS, where an inherited ACL
under `/Users/Shared` means `chmod 000` cannot make a file unreadable. That case runs on Linux.
The full suite takes about **7 seconds** (roughly 0.4 s per fixture, dominated by JVM startup),
which is why the probe is a prebuilt fat jar rather than a Gradle invocation. Verify with
`node ../spec/runner/run.mjs --probe java`.

Implements **SPEC 1.0.0** ([`../spec/SPEC.md`](../spec/SPEC.md)). Last conformance run: **2026-08-11**.

## Quickstart

```java
import dev.configdiscovery.ConfigDiscovery;
import dev.configdiscovery.Loaded;

Loaded loaded = ConfigDiscovery.load("mytool");

if (!loaded.found()) {
    System.err.println("no config file found; using defaults");
}
loaded.sources().forEach(source ->
        System.err.println(source.precedence() + " " + source.path()));
```

`loaded.config()` is a Jackson `JsonNode`. For a type of your own:

```java
record Settings(String logLevel, int port) {}

Settings settings = loaded.as(Settings.class);
```

Binding does **not** weakly coerce: a string where an `int` belongs is a
`ConfigException(VALIDATION)`. The spec already coerced at load time, and coercing a second time
would repair the data rather than report it.

`LoadOptions.builder().strict(true)` turns a key the target type has no property for into
`ConfigException(UNKNOWN_KEY)` with the key path.

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

`LoadOptions.builder()` covers every SPEC §6 option: `strategy`, `arrayMerge`, `stopDir`,
`envPrefix`, `profile`, `strict`, `home`, `cwd`, `env`, `defaults`, `overrides`, `relativeTo`,
`warningHandler`.

`cwd`, `home`, and `env` replace the only three ambient inputs `load` reads — and on the JVM that
matters more than elsewhere, because `user.home` and `user.dir` are process-global and cannot be
varied per test. Every test in this module passes its own.

## Environment variables

```
MYTOOL_LOG__LEVEL=trace   ->  {"log": {"level": "trace"}}
MYTOOL_PORT=5432          ->  {"port": 5432}          // an IntNode, so it serializes as 5432
MYTOOL_NAME=5432abc       ->  {"name": "5432abc"}     // a TextNode
MYTOOL_SOME_KEY=1         ->  {"some_key": 1}         // one underscore is literal
```

`__` splits nesting levels. Values are parsed as JSON when they parse and kept as strings when
they do not — with `FAIL_ON_TRAILING_TOKENS` enabled, which is what makes `5432abc` a string
rather than the number 5432 followed by ignored garbage.

## Validation

Jakarta Bean Validation constraints on the bound type are enforced **when a validator is on the
classpath**, and skipped silently when one is not. `jakarta.validation-api` is `compileOnly`
here: a consumer who wants constraint checking adds a validator, and one who does not pays
nothing. Detection is reflective for the same reason.

A violation becomes `ConfigException(VALIDATION)` with `keyPath` from the constraint's property
path.

## Errors

Nothing found is **not** an error: you get `found() == false`. A file that exists and is broken
**is** an error, because silently falling back to defaults when a YAML file has a tab in it turns
a typo into an incident.

```java
try {
    ConfigDiscovery.load("mytool");
} catch (ConfigException failure) {
    System.err.println(failure.kind() + " " + failure.path() + " " + failure.line());
}
```

`kind()` is one of `NOT_FOUND`, `UNREADABLE`, `MALFORMED`, `DUPLICATE_FORMAT`, `UNKNOWN_KEY`,
`VALIDATION`. Branch on it; never match the message text.

## Notes on the Jackson wrapping

- Every dataformat module returns the same tree type, `JsonNode`, so the merge is written once
  rather than per format. That is a real advantage over the other four language packages, each of
  which had to normalize its parsers' output first.
- `.jsonc` uses `JsonReadFeature.ALLOW_JAVA_COMMENTS`. Every other language in this repository
  ships a hand-rolled comment stripper; this one does not need to.
- `.env` uses dotenv-java, but only `Dotenv.Filter.DECLARED_IN_ENV_FILE`. **dotenv-java merges
  `System.getenv()` into its result by default**, which would silently make every fixture depend
  on the developer's shell.

## Development

```sh
./gradlew test        # unit tests plus the cross-language conformance suite
./gradlew build
./gradlew :core:probeJar
```

The Gradle wrapper is committed, so `./gradlew` works with no Gradle installed. Compilation
targets Java 21 via `options.release`, so any JDK 21 or newer builds it.

# `config-discovery-spring`

An optional adapter that exposes `.config/<packageName>/` discovery through Spring Boot's own
property-source mechanism, so `@ConfigurationProperties` and relaxed binding keep working
unchanged.

Depends on [`../core`](../README.md), which has no Spring on its classpath at all. Nothing in
`core` depends on this module, and CI checks that.

## Usage

Put the module on the classpath and give it a package name:

```properties
spring.application.name=mytool
```

or, when the discovery name is not the application name:

```properties
config-discovery.package-name=mytool
```

That is the whole setup. The post-processor registers itself through
`META-INF/spring.factories` and runs before the context is created, so discovered values are
visible to everything Spring does afterward.

Two extra properties exist for tests and for unusual deployments:
`config-discovery.cwd` and `config-discovery.home` override the directories discovery starts
from.

## The order you actually get

**This adapter does not reproduce [SPEC §3](../../spec/SPEC.md) overall, and does not claim to.**
Spring interleaves its own property sources, and a library cannot reorder them. What the adapter
guarantees is the spec's *relative* order among the sources it contributes.

Highest priority first, in a typical Spring Boot application:

| # | Source | Whose |
| --- | --- | --- |
| 1 | Devtools / test property sources | Spring |
| 2 | Command-line arguments | Spring |
| 3 | `SPRING_APPLICATION_JSON` | Spring |
| 4 | Servlet / JNDI parameters | Spring |
| 5 | Java system properties | Spring |
| 6 | OS environment variables | Spring |
| 7 | `application-{profile}.yml` / `.properties` | Spring |
| 8 | `application.yml` / `.properties` | Spring |
| 9 | **project-local `.config/mytool/`, nearest ancestor first** | this adapter |
| 10 | **user-level `~/.config/mytool/`** | this adapter |
| 11 | `@PropertySource` and defaults | Spring |

Where that differs from SPEC §3, explicitly:

- **Environment variables.** SPEC §3.1 puts the prefixed environment layer *above* every file
  layer. In Spring, the OS environment sits above `application.yml` and therefore above this
  adapter's sources too — the same direction, but Spring's whole environment participates, not
  only `MYTOOL_*`.
- **`application.yml` outranks your `.config/mytool/` files.** There is no equivalent layer in
  SPEC §3 at all. If that is the wrong answer for your application, do not add
  `application.yml`; use `core` directly instead of this adapter.
- **`.env` files.** SPEC §3.1 applies a root's `.env` inside that root's block. The adapter
  flattens each root into a single `MapPropertySource`, so `.env` values are already merged in at
  the root's position rather than being separately visible to Spring.

If you need SPEC §3 exactly, call `ConfigDiscovery.load` from `core` and use the result directly.
That is the honest recommendation: an adapter that claimed parity would be a claim a user
discovers is false at the worst possible moment.

## Core behavior

Everything about *which* files are found and *how* they merge is
[`docs/CONFIGURATION.md`](../../../docs/CONFIGURATION.md), and normatively
[`../../spec/SPEC.md`](../../spec/SPEC.md). This document covers only the Spring ordering.

# Releasing `config-discovery-core` and `config-discovery-spring` (Maven Central)

## Before publishing anything

The same checklist for all five packages. Every box is checked before any registry sees a byte.

- [ ] `node packages/spec/runner/run.mjs --probe <lang>` exits 0, with only documented platform skips.
- [ ] The package's own tests pass.
- [ ] The version is bumped per [`docs/VERSIONING.md`](../../docs/VERSIONING.md).
- [ ] The changelog has an entry, naming the spec version if this release implements a spec change.
- [ ] The README is accurate, including the spec version it claims to implement and the fixture pass count.
- [ ] The support-matrix row in [`packages/README.md`](../README.md) is current.

## Before the very first publish: settle the groupId

The Java *package* is `dev.configdiscovery`. The Maven **groupId** is a separate decision, and
Central verifies namespace ownership before accepting one:

- `dev.configdiscovery` requires proving control of the domain `configdiscovery.dev`.
- `io.github.multistageharness` requires only the GitHub account, which already exists.

Unless the domain is owned, publish under `io.github.multistageharness`. The Java package name
does not have to match the groupId, and changing the groupId later means republishing under a
new coordinate that no existing dependency will pick up.

## Publishing

```sh
cd packages/java
./gradlew test              # both modules, plus the conformance suite
./gradlew build
./gradlew publish           # to the Central publishing portal
```

Central requires, for every artifact: a sources jar, a javadoc jar, a POM with name, description,
url, licence, developer and SCM blocks, and a detached GPG signature for each file. A release
missing any of these is rejected at validation, after upload.

## Authentication

A Central portal token (user token pair) plus a GPG key whose public half is on a public
keyserver. Both go in `~/.gradle/gradle.properties` or the environment — never in the
repository.

## Irreversible

- **Released artifacts cannot be deleted or modified.** Central is append-only by design; there
  is no yank, no unpublish, and no overwrite.
- A mistake is fixed by releasing the next version.
- The groupId, once verified and used, is effectively permanent for these artifacts.

## After publishing

- [ ] The coordinates resolve from `repo1.maven.org` (allow up to a few hours for the sync).
- [ ] In a scratch project: depend on the new version and compile against it.
- [ ] Update the support matrix with the published version.

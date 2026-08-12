# Releasing `config-discovery` (crates.io)

## Before publishing anything

The same checklist for all five packages. Every box is checked before any registry sees a byte.

- [ ] `node packages/spec/runner/run.mjs --probe <lang>` exits 0, with only documented platform skips.
- [ ] The package's own tests pass.
- [ ] The version is bumped per [`docs/VERSIONING.md`](../../docs/VERSIONING.md).
- [ ] The changelog has an entry, naming the spec version if this release implements a spec change.
- [ ] The README is accurate, including the spec version it claims to implement and the fixture pass count.
- [ ] The support-matrix row in [`packages/README.md`](../README.md) is current.

## Publishing

```sh
cd packages/rust
cargo test --all-features   # unit tests plus the conformance suite
cargo clippy --all-features -- -D warnings
cargo publish --dry-run     # packages and verifies exactly what would be uploaded
cargo publish
```

`--dry-run` builds the package from the packaged files rather than from the working tree, which
is how a missing `include`/`exclude` entry or an uncommitted file gets caught before it
matters.

## Authentication

A crates.io API token from `cargo login`, or `CARGO_REGISTRY_TOKEN` in CI. Scope the token to
publish-update where possible.

## Irreversible

- **A version can never be overwritten.** `cargo publish` of an existing version is rejected.
- **Yank hides a version from new resolution but does not remove it**; anything with it in a
  lockfile keeps building.
- **The crate name is permanent** and cannot be transferred away casually. `config-discovery`
  was confirmed unregistered on 2026-08-11; confirm again immediately before the first publish,
  because the window between checking and publishing is the whole risk.

## Feature flags

The published crate defaults to `toml` and `json`. Conformance is claimed for the
`--all-features` build, and the README says so. If the default feature set changes, that is a
behavior change for existing users and needs a version bump under
[`docs/VERSIONING.md`](../../docs/VERSIONING.md).

## After publishing

- [ ] `cargo search config-discovery` shows the new version.
- [ ] In a scratch crate: depend on it from crates.io and build.
- [ ] Update the support matrix with the published version.

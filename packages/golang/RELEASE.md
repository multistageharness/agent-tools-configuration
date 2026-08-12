# Releasing the Go module

## Before publishing anything

The same checklist for all five packages. Every box is checked before any registry sees a byte.

- [ ] `node packages/spec/runner/run.mjs --probe <lang>` exits 0, with only documented platform skips.
- [ ] The package's own tests pass.
- [ ] The version is bumped per [`docs/VERSIONING.md`](../../docs/VERSIONING.md).
- [ ] The changelog has an entry, naming the spec version if this release implements a spec change.
- [ ] The README is accurate, including the spec version it claims to implement and the fixture pass count.
- [ ] The support-matrix row in [`packages/README.md`](../README.md) is current.

## Publishing is tagging

There is no upload step. The module proxy fetches from the repository when someone asks for a
version, so publishing is creating and pushing a tag.

This module lives in a subdirectory, so the tag carries the subdirectory prefix:

```sh
cd packages/golang
go test ./...               # unit tests plus the conformance suite
go vet ./... && gofmt -l .

git tag packages/golang/v0.1.0
git push origin packages/golang/v0.1.0
```

A plain `v0.1.0` tag would publish the *repository root* as a module, which is not what this
is. The prefix is mandatory for a subdirectory module.

Verify the proxy picked it up:

```sh
GOPROXY=https://proxy.golang.org go list -m \
  github.com/multistageharness/agent-tools-configuration/packages/golang@v0.1.0
```

## Major versions above one

`v2` and beyond need the major version in the import path — the module path becomes
`.../packages/golang/v2` and `go.mod` must say so. That is a source change, not just a tag,
and every consumer's import lines change with it.

## Authentication

None. Push access to the repository is the only credential.

## Irreversible

- **The module proxy caches a tag permanently.** Deleting or moving a tag does not un-publish it;
  the proxy keeps serving what it already fetched, and a moved tag produces a checksum mismatch
  for everyone who already downloaded it — which is worse than a bad release.
- A bad release is withdrawn with a `retract` directive in `go.mod` plus a new tag, never by
  deleting the old one.

## After publishing

- [ ] `go list -m ...@vX.Y.Z` resolves through the public proxy.
- [ ] In an empty module: `go get` the new version and build against it.
- [ ] Update the support matrix with the published version.

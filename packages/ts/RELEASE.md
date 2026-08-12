# Releasing `@multistageharness/config-discovery` (npm)

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
cd packages/ts
npm ci
npm test                    # vitest plus the conformance suite
npm run build
npm pack --dry-run          # read the file list: dist/, README.md, package.json, nothing else
npm publish --access public
```

`--access public` is required: a scoped package defaults to private, and the publish fails with
a payment-required error that reads like an unrelated account problem.

## Authentication

Either an automation token in `NPM_TOKEN`, or — preferred — npm trusted publishing (OIDC) from
a GitHub Actions workflow, which needs no long-lived secret. Trusted publishing must be
configured on the npm package page before the first automated publish; the first publish itself
is manual.

## Irreversible

- **A published version can never be replaced.** `npm publish` of an existing version fails; it
  does not overwrite.
- **Unpublish is restricted after 72 hours**, and even inside that window it is restricted if
  anything depends on the package. Assume publish is permanent.
- The package *name* is permanent once used, even after an unpublish.

## After publishing

- [ ] `npm view @multistageharness/config-discovery version` reports the new version.
- [ ] In a clean directory: `npm install @multistageharness/config-discovery` and import it.
- [ ] Update the support matrix with the published version.

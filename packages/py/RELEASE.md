# Releasing `config-discovery` (PyPI)

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
cd packages/py
pip install -e ".[dev]" build twine
pytest                      # unit tests plus the conformance suite
python -m build             # produces dist/*.whl and dist/*.tar.gz
twine check dist/*
twine upload --repository testpypi dist/*     # dry run first, always
twine upload dist/*
```

The TestPyPI upload is not optional in practice: it is the only way to see the rendered README
and the metadata as PyPI will see them, and README rendering failures are rejected at upload.

## Authentication

An API token in `~/.pypirc` or `TWINE_PASSWORD` with `TWINE_USERNAME=__token__`, or PyPI
trusted publishing (OIDC) from GitHub Actions. Scope the token to this project, not to the whole
account.

## Irreversible

- **A filename can never be reused**, even after deleting the release. Uploading
  `config_discovery-1.0.0-py3-none-any.whl` and then deleting it means version 1.0.0 can never
  be published again — you must burn a version number.
- Yanking hides a release from resolution but does not remove it.
- The project name is permanent.

## After publishing

- [ ] `pip index versions config-discovery` shows the new version.
- [ ] In a fresh virtualenv: `pip install config-discovery` and `import config_discovery`.
- [ ] Update the support matrix with the published version.

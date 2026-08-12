"""The conformance probe - the adapter between packages/spec/PROBE.md and load().

The stdout-purity rule of PROBE.md section 4 deserves extra care in Python: a `warnings` call, a
stray `print` in a dependency, or an interpreter notice would each corrupt the protocol. Dynaconf
in particular prints a UserWarning when an optional format extra is missing. So stdout is
replaced with a buffer for the whole of the load and forwarded to stderr afterward, and the one
JSON document is written to the real stdout only once the work is done.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import sys
import traceback
import warnings
from pathlib import Path, PurePosixPath

# So the probe exercises this checkout rather than whatever happens to be installed.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from config_discovery import ConfigError, load  # noqa: E402

#: SPEC section 6. Anything outside this set exits 2 rather than being quietly ignored: a probe
#: that shrugs off `array_merge` and still prints a result claims conformance it does not have.
KNOWN_OPTIONS = {
    "strategy",
    "arrayMerge",
    "stopDir",
    "envPrefix",
    "profile",
    "strict",
    "defaults",
    "overrides",
}

OPTION_NAMES = {
    "strategy": "strategy",
    "arrayMerge": "array_merge",
    "stopDir": "stop_dir",
    "envPrefix": "env_prefix",
    "profile": "profile",
    "strict": "strict",
    "defaults": "defaults",
    "overrides": "overrides",
}


class Usage(Exception):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--package-name", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--home", required=True)
    parser.add_argument("--fixture-root", required=True)
    parser.add_argument("--env", action="append", default=[])
    parser.add_argument("--options", default="{}")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        raise Usage(f"unknown flag {unknown[0]!r}")
    return args


def relativize(path: str, fixture_root: Path) -> str:
    candidate = Path(path)
    if not candidate.is_absolute():
        return path
    try:
        return PurePosixPath(candidate.relative_to(fixture_root)).as_posix()
    except ValueError:
        return PurePosixPath(candidate).as_posix()


def main(argv: list[str]) -> int:
    warnings.simplefilter("ignore")
    try:
        args = parse_args(argv)
        env = {}
        for pair in args.env:
            name, sep, value = pair.partition("=")
            if not sep or not name:
                raise Usage(f"--env expects KEY=VALUE, got {pair!r}")
            env[name] = value
        options = json.loads(args.options)
        unsupported = set(options) - KNOWN_OPTIONS
        if unsupported:
            raise Usage(f"unsupported option {sorted(unsupported)[0]!r} (SPEC section 6)")
    except SystemExit:
        # argparse has already explained itself on stderr.
        return 2
    except (Usage, json.JSONDecodeError) as error:
        print(str(error) or "bad usage", file=sys.stderr)
        return 2

    # Resolved, so a --fixture-root containing `..` or a symlinked temp directory still lines up
    # with the resolved paths discovery produces.
    fixture_root = Path(args.fixture_root).resolve()
    kwargs = {OPTION_NAMES[key]: value for key, value in options.items()}
    if "stop_dir" in kwargs:
        kwargs["stop_dir"] = Path(kwargs["stop_dir"])

    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            result = load(
                args.package_name,
                cwd=Path(args.cwd).resolve(),
                home=Path(args.home).resolve(),
                # Built only from --env. Never os.environ: this is the line that stops a
                # developer's exported MYTOOL_LOG__LEVEL from changing fixture results.
                env=env,
                relative_to=fixture_root,
                on_warning=lambda message: print(message, file=sys.stderr),
                **kwargs,
            )
    except ConfigError as error:
        sys.stderr.write(captured.getvalue())
        payload = {"kind": error.kind, "message": str(error)}
        if error.path is not None:
            payload["path"] = relativize(error.path, fixture_root)
        if error.key_path is not None:
            payload["keyPath"] = error.key_path
        sys.stdout.write(json.dumps({"error": payload}))
        return 1
    except Exception:
        # Not a ConfigError: this harness is broken, not the library rejecting input. Exit 2, so
        # the runner reports the case as unproven rather than as a conformance failure.
        sys.stderr.write(captured.getvalue())
        traceback.print_exc(file=sys.stderr)
        return 2

    sys.stderr.write(captured.getvalue())
    sys.stdout.write(
        json.dumps(
            {
                "config": result.config,
                "found": result.found,
                "sources": [
                    {
                        "path": source.path,
                        "format": source.format,
                        "precedence": source.precedence,
                        "keys": source.keys,
                    }
                    for source in result.sources
                ],
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

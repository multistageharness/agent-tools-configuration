"""``config-discovery`` - the public surface.

Load a program's configuration from ``./.config/<package_name>/``, walking up from the working
directory, with a fallback to ``~/.config/<package_name>/``, layered so project-local wins.

Behavior is defined by ``packages/spec/SPEC.md``. This module assembles discovery, loading,
merging, the env layer, and validation into the one function a consumer imports.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable

from .discover import resolve_project_roots, resolve_user_root
from .env import env_layer
from .errors import ConfigError, Kind
from .loaders import list_config_files, load_one
from .merge import apply_strategy, merge_layers
from .sources import build_sources
from .types import Format, Layer, Loaded, Source
from .validate import apply_schema

__all__ = [
    "ConfigError",
    "Format",
    "Kind",
    "Layer",
    "Loaded",
    "Source",
    "apply_strategy",
    "build_sources",
    "env_layer",
    "list_config_files",
    "load",
    "load_one",
    "merge_layers",
    "resolve_project_roots",
    "resolve_user_root",
]

__version__ = "0.1.0"


def _default_warning(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def load(
    package_name: str,
    *,
    strategy: str = "layered",
    array_merge: str = "replace",
    stop_dir: Path | None = None,
    env_prefix: str | None = None,
    profile: str | None = None,
    strict: bool = False,
    home: Path | None = None,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    defaults: dict[str, Any] | None = None,
    overrides: dict[str, Any] | None = None,
    schema: Callable[[dict[str, Any]], Any] | None = None,
    relative_to: Path | None = None,
    on_warning: Callable[[str], None] | None = None,
) -> Loaded:
    """Load ``package_name``'s configuration.

    Finding nothing is not an error: the result is the defaults with ``found=False`` and an empty
    ``sources``. Finding something broken **is** an error - a :class:`ConfigError` naming the
    path - because silently falling back to defaults when a YAML file has a tab in it is how a
    typo becomes an incident.
    """
    invalid = "/" in package_name or "\\" in package_name or package_name in (".", "..")
    if not package_name or invalid:
        # A programming error, not a configuration one: it has no SPEC section 5 kind, and
        # dressing it up as a ConfigError would put it in the same except block as a broken file.
        raise ValueError(f"package name {package_name!r} must be a single path segment")

    # The ambient process is read in exactly these three places, and each is overridable. That
    # is what makes the conformance probe and every test in this package hermetic.
    resolved_cwd = Path(cwd) if cwd is not None else Path.cwd()
    resolved_home = Path(home) if home is not None else Path.home()
    resolved_env: Mapping[str, str] = env if env is not None else os.environ
    prefix = (env_prefix or re.sub(r"[^A-Z0-9]", "_", package_name.upper())).upper()
    warn = on_warning or _default_warning

    user_root = resolve_user_root(
        package_name, home=resolved_home, env=resolved_env, on_warning=warn
    )
    project_roots = resolve_project_roots(
        resolved_cwd, package_name, home=resolved_home, stop_dir=stop_dir
    )

    blocks: list[tuple[Path, int]] = []
    if user_root is not None:
        blocks.append((user_root, 1))
    blocks.extend((root, 2) for root in project_roots)

    layers: list[Layer] = []
    if defaults:
        layers.append(
            Layer(value=dict(defaults), source=Source("<defaults>", "defaults", 0), root=None)
        )

    for root, precedence in blocks:
        for path, fmt in list_config_files(root, profile):
            value = load_one(path, fmt, env_prefix=prefix)
            layers.append(
                Layer(
                    value=value,
                    # SPEC section 3.1: a .env is its own layer, applied inside its root's block.
                    source=Source(str(path), fmt, 3 if fmt == "dotenv" else precedence),
                    root=str(root),
                )
            )

    from_env = env_layer(resolved_env, prefix, warn)
    if from_env:
        layers.append(Layer(value=from_env, source=Source("<env>", "env", 4), root=None))
    if overrides:
        layers.append(
            Layer(value=dict(overrides), source=Source("<overrides>", "overrides", 5), root=None)
        )

    contributing = apply_strategy(layers, strategy)
    config = merge_layers(contributing, array_merge=array_merge, on_warning=warn)

    if schema is not None:
        config = apply_schema(config, schema, strict=strict, on_warning=warn)

    # The boundary assertion: a LazySettings or DynaBox that leaked this far fails loudly in a
    # test rather than silently in the probe's output.
    if type(config) is not dict and schema is None:  # noqa: E721 - subclasses are the bug
        raise TypeError(f"internal error: merged config is {type(config).__name__}, not dict")

    return Loaded(
        config=config,
        # SPEC section 7: `found` reflects files only. Defaults and env do not set it.
        found=any(layer.root is not None for layer in contributing),
        sources=build_sources(contributing, relative_to=relative_to),
    )

"""Search-path resolution - SPEC section 2.

Dynaconf never walks anywhere: it takes an explicit ``settings_files`` list and reads it. The
upward walk is therefore entirely ours, in every language, and this module is the Python half of
keeping those five hand-written walks identical.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Callable

from .errors import ConfigError

#: A pathological mount or an uncollapsed symlink loop should fail loudly rather than spin. No
#: real tree is 64 directories deep below its repository root.
MAX_DEPTH = 64


def resolve_project_roots(
    cwd: Path,
    package_name: str,
    *,
    home: Path,
    stop_dir: Path | None = None,
) -> list[Path]:
    """Every existing ``.config/<package_name>/`` from *cwd* upward, farthest ancestor first.

    Farthest-first is the SPEC section 2.7 order, so the nearest root is last and therefore
    wins.
    """
    start = Path(cwd).resolve()  # SPEC section 2.1: resolved exactly once.
    home_resolved = Path(home).resolve()
    stop_resolved = Path(stop_dir).resolve() if stop_dir is not None else None

    roots: list[Path] = []
    for depth, directory in enumerate([start, *start.parents]):
        if depth > MAX_DEPTH:
            raise ConfigError(
                "unreadable",
                f"upward walk exceeded {MAX_DEPTH} directories starting at {cwd}",
                path=str(cwd),
            )

        # SPEC section 2.2: a directory is checked before it is tested for stopping, so a config
        # beside a .git is found and the walk then ends.
        candidate = directory / ".config" / package_name
        if candidate.is_dir():
            roots.append(candidate)

        at_filesystem_root = directory == directory.parent
        at_home = directory == home_resolved
        at_stop_dir = stop_resolved is not None and directory == stop_resolved
        # Both forms count: a directory in a normal clone, a file in a worktree or submodule.
        at_repository_boundary = (directory / ".git").exists()
        if at_filesystem_root or at_home or at_stop_dir or at_repository_boundary:
            break

    roots.reverse()
    return roots


def resolve_user_root(
    package_name: str,
    *,
    home: Path,
    env: Mapping[str, str],
    on_warning: Callable[[str], None],
) -> Path | None:
    """The single user-level root of SPEC section 2.4, or ``None`` when it does not exist.

    ``None`` rather than a missing directory so a caller can tell "no user config at all" from
    "the user config directory is empty".

    Windows takes this identical path. ``%APPDATA%`` and ``%LOCALAPPDATA%`` are deliberately not
    consulted (SPEC section 2.4): the same directory has to be readable by five language
    implementations, and one documented location beats a native one nobody can predict.
    """
    xdg = env.get("XDG_CONFIG_HOME")
    if xdg and Path(xdg).is_absolute():
        root = Path(xdg) / package_name
    else:
        if xdg is not None:
            on_warning(
                f"ignoring XDG_CONFIG_HOME={xdg!r}: it must be a non-empty absolute path "
                "(SPEC section 2.4)"
            )
        root = Path(home) / ".config" / package_name
    return root if root.is_dir() else None

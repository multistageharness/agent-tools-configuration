"""The ``sources`` output - SPEC section 7.

This is the only thing standing between a user who expected ``debug`` and an afternoon of
guessing which of six layers set ``trace``, so every source that was read is listed, winners and
losers alike.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath

from .types import Layer, Source


def _rewrite(path: str, relative_to: Path | None) -> str:
    # <defaults>, <env> and <overrides> are labels, not paths, and are passed through.
    candidate = Path(path)
    if relative_to is None or not candidate.is_absolute():
        return path
    try:
        relative = candidate.relative_to(Path(relative_to))
    except ValueError:
        # Outside the fixture root: stay absolute rather than emit a ../../ climb that no
        # expected.json could match.
        return PurePosixPath(candidate).as_posix()
    return PurePosixPath(relative).as_posix()


def build_sources(layers: list[Layer], *, relative_to: Path | None = None) -> list[Source]:
    """Entry order is **application order** - the order the layers were merged, lowest effective
    priority first (SPEC section 3.1).

    That is ascending precedence with one documented exception: a root's ``.env`` (precedence 3)
    belongs inside that root's block, so a user-level ``.env`` still loses to a project-local
    ``config.toml``. Sorting this list by precedence would reorder it into something that does
    not describe what happened.
    """
    return [
        Source(
            path=_rewrite(layer.source.path, relative_to),
            format=layer.source.format,
            precedence=layer.source.precedence,
            keys=sorted(layer.value.keys()) if isinstance(layer.value, dict) else [],
        )
        for layer in layers
    ]

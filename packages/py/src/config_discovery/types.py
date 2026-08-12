"""The public data types. SPEC section 7 (output contract)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Format = Literal[
    "toml",
    "yaml",
    "json",
    "jsonc",
    "ini",
    "dotenv",
    "env",
    "defaults",
    "overrides",
]


@dataclass(frozen=True)
class Source:
    """One contributing input. Every source that was read appears, winner or not."""

    #: Absolute at runtime; rewritten by ``relative_to``. ``<defaults>``, ``<env>`` and
    #: ``<overrides>`` for the layers that are not files.
    path: str
    format: str
    #: The layer number from the SPEC section 3.1 table.
    precedence: int
    #: The top-level keys this source contributed, sorted. Empty for a file that parsed empty.
    keys: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Loaded:
    """What ``load`` returns."""

    #: Always a plain ``dict`` - never a ``LazySettings``. Asserted at the boundary.
    config: dict[str, Any]
    #: True when at least one recognized *file* contributed. Defaults and env do not set it.
    found: bool
    #: Application order, lowest effective priority first (SPEC section 3.1).
    sources: list[Source]


@dataclass
class Layer:
    """One layer on its way into the merge, with the source it will be reported as."""

    value: dict[str, Any]
    source: Source
    #: The config directory this layer came from, for ``first-match``. ``None`` for the layers
    #: that belong to no root: defaults, env, overrides.
    root: str | None = None

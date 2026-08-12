"""The error model of SPEC section 5.

Every failure carries a machine-readable ``kind`` from a closed list, so callers - and the
conformance suite - branch on the failure rather than matching message text, which differs per
parser and per language.
"""

from __future__ import annotations

from typing import Any, Literal

Kind = Literal[
    "not-found",
    "unreadable",
    "malformed",
    "duplicate-format",
    "unknown-key",
    "validation",
]

KINDS: tuple[str, ...] = (
    "not-found",
    "unreadable",
    "malformed",
    "duplicate-format",
    "unknown-key",
    "validation",
)


class ConfigError(Exception):
    """A configuration failure with a SPEC section 5 ``kind``."""

    def __init__(
        self,
        kind: Kind,
        message: str,
        *,
        path: str | None = None,
        line: int | None = None,
        column: int | None = None,
        key_path: str | None = None,
        issues: list[Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.kind: Kind = kind
        self.path = path
        self.line = line
        self.column = column
        self.key_path = key_path
        self.issues = issues

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ConfigError(kind={self.kind!r}, path={self.path!r}, message={str(self)!r})"

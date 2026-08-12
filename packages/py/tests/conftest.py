"""Shared fixtures.

Every test builds its own tree under ``tmp_path`` and injects ``cwd`` and ``home``. Nothing in
this suite may read the real working directory or the real home - a suite whose results depend
on the machine it runs on is not a suite.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import pytest


@pytest.fixture
def tree(tmp_path: Path) -> Callable[[dict[str, str]], Path]:
    """Materialize ``{relative path: contents}`` under ``tmp_path`` and return its root.

    A path ending in ``/`` creates an empty directory.
    """

    def build(files: dict[str, str]) -> Path:
        for relative, contents in files.items():
            target = tmp_path / relative
            if relative.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(contents, encoding="utf-8")
        return tmp_path

    return build


@pytest.fixture
def warnings_sink() -> tuple[list[str], Callable[[str], None]]:
    """Collects warnings so a test can assert on the diagnostic as well as the behavior."""
    collected: list[str] = []
    return collected, collected.append

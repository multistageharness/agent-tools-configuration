"""The cross-language conformance suite, run as part of this package's own tests.

A conformance regression should fail ``pytest``, not only CI - the point of the fixture suite is
that it is cheap enough to run on every change.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNNER = REPO_ROOT / "packages/spec/runner/run.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="the conformance runner needs node")
def test_every_fixture_passes() -> None:
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", str(RUNNER), "--probe", "py"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"

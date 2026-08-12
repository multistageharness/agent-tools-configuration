"""The environment-variable layer - SPEC section 4.5 - and the name mapping ``.env`` files
share with it (SPEC section 4.6).

**Dynaconf's own environment loader is deliberately not used here.** Dynaconf infers types with
its own grammar - ``@int``, ``@json``, ``@format`` markers plus bare-token inference - and that
grammar does not agree with SPEC section 4.5 at the edges. It also reads the *process*
environment, which would make a fixture's result depend on the developer's shell.

The rule implemented here is parse-as-JSON-or-keep-the-string, chosen because JSON is the one
grammar all five ecosystems already have. If a later reader "simplifies" this module back onto
Dynaconf, the ``env-var-beats-files`` fixture is what will break, and it will break by producing
the string ``"5432"`` where the number ``5432`` is required.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Callable


def env_key_path(name: str) -> list[str]:
    """Variable name (prefix already stripped) to key path.

    Lowercase, split on ``__``, and leave a single ``_`` alone: ``SOME_KEY`` is the single key
    ``some_key``, not ``some.key``.
    """
    return [segment for segment in name.lower().split("__") if segment]


def coerce_value(raw: str, *, was_quoted: bool = False) -> Any:
    """SPEC section 4.5 step 5.

    ``was_quoted`` short-circuits it for ``.env`` values written inside quotes, which section
    4.6 keeps as strings.
    """
    if was_quoted:
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        # Note that ``json`` accepts ``true`` but not Python's ``True``: the latter is not JSON
        # and therefore stays the string it was written as. That is the intended behavior.
        return raw


def assign_path(target: dict[str, Any], path: list[str], value: Any) -> None:
    """Write *value* at *path*, creating dicts along the way and replacing non-dicts."""
    if not path:
        return
    node = target
    for segment in path[:-1]:
        existing = node.get(segment)
        if not isinstance(existing, dict):
            node[segment] = {}
        node = node[segment]
    node[path[-1]] = value


def env_layer(
    env: Mapping[str, str],
    prefix: str,
    on_warning: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Layer 4.

    *env* is required and is never defaulted to ``os.environ`` in here: the probe and every test
    depend on an exported ``MYTOOL_*`` in the developer's shell being unable to reach this
    function.
    """
    result: dict[str, Any] = {}
    marker = f"{prefix}_"
    for name, raw in env.items():
        if not name.startswith(marker):
            continue
        path = env_key_path(name[len(marker) :])
        if not path:
            if on_warning is not None:
                on_warning(f"ignoring {name}: it maps to an empty key path")
            continue
        assign_path(result, path, coerce_value(raw))
    return result

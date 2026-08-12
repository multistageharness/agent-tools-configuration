"""Merge semantics - SPEC section 4.

Dynaconf has no switch that produces the combination the spec requires - deep-merged maps *with*
wholesale-replaced lists - so the merge is written here rather than configured there.

The structure deliberately mirrors ``packages/ts/src/merge.ts``. When a fixture disagreement has
to be adjudicated, two independent implementations that are structurally comparable are far
easier to reconcile than two that are merely both correct.
"""

from __future__ import annotations

from typing import Any, Callable

from .types import Layer

#: Python conflates "key not present" with ``None``, and SPEC section 4.4 depends on telling
#: them apart: an absent key is left alone, a ``None`` key is deleted. This sentinel is the
#: difference, and it is the single most likely bug in this file.
_ABSENT = object()


def _merge_into(
    lower: dict[str, Any],
    higher: dict[str, Any],
    *,
    array_merge: str,
    on_warning: Callable[[str], None] | None,
    path: str,
) -> dict[str, Any]:
    out = dict(lower)
    for key, value in higher.items():
        at = key if not path else f"{path}.{key}"

        # SPEC section 4.4.
        if value is None:
            out.pop(key, None)
            continue

        existing = out.get(key, _ABSENT)

        # An explicit isinstance(..., dict) check, not Mapping: a LazySettings or a DynaBox that
        # leaked this far must fail visibly rather than merge as if it were data.
        if isinstance(existing, dict) and isinstance(value, dict):
            out[key] = _merge_into(
                existing, value, array_merge=array_merge, on_warning=on_warning, path=at
            )
            continue

        if isinstance(existing, list) and isinstance(value, list):
            # SPEC section 4.3: replace by default; concat appends and never deduplicates.
            out[key] = [*existing, *value] if array_merge == "concat" else value
            continue

        if existing is not _ABSENT and isinstance(existing, dict) != isinstance(value, dict):
            if on_warning is not None:
                was = "a map" if isinstance(existing, dict) else "a scalar"
                now = "a map" if isinstance(value, dict) else "a scalar"
                on_warning(f"{at}: replacing {was} with {now} (SPEC section 4.2)")

        out[key] = value
    return out


def merge_layers(
    layers: list[Layer],
    *,
    array_merge: str = "replace",
    on_warning: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Fold the layers lowest precedence first."""
    result: dict[str, Any] = {}
    for layer in layers:
        if not isinstance(layer.value, dict):
            continue
        result = _merge_into(
            result, layer.value, array_merge=array_merge, on_warning=on_warning, path=""
        )
    return result


def apply_strategy(layers: list[Layer], strategy: str) -> list[Layer]:
    """SPEC section 3.2.

    Under ``first-match`` only the highest-precedence root that contributed a file survives - the
    lower roots are dropped from the merge **and** from ``sources``, because the option means
    "the others were never consulted", not "the others lost".

    The rootless layers - defaults, env, overrides - always survive: the option scopes the file
    layers only.
    """
    if strategy != "first-match":
        return layers
    rooted = [layer.root for layer in layers if layer.root is not None]
    winning_root = rooted[-1] if rooted else None
    return [layer for layer in layers if layer.root is None or layer.root == winning_root]

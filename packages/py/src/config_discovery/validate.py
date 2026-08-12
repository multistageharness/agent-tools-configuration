"""Optional validation - SPEC section 5, kinds ``validation`` and ``unknown-key``.

No validator is depended on. The caller passes a callable, so a Pydantic model, an attrs class,
or a hand-written function all work unchanged.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable

from .errors import ConfigError


def _known_fields(schema: Any) -> list[str] | None:
    """Best effort at the schema's declared top-level fields, for ``strict``.

    A plain callable declares nothing, so this gives up cleanly rather than pretending - see the
    README: where the fields are not discoverable, ``strict`` defers to the validator's own
    strictness rather than silently doing nothing.
    """
    model_fields = getattr(schema, "model_fields", None)  # Pydantic v2
    if isinstance(model_fields, dict):
        return list(model_fields)
    dataclass_fields = getattr(schema, "__dataclass_fields__", None)
    if isinstance(dataclass_fields, dict):
        return list(dataclass_fields)
    # A function's __annotations__ are its *parameters*, not a set of fields. Reading them as
    # fields makes every plain-callable schema reject every key it was handed.
    if inspect.isroutine(schema):
        return None
    annotations = getattr(schema, "__annotations__", None)
    if isinstance(annotations, dict) and annotations:
        return [name for name in annotations if name != "return"]
    return None


def _issues_of(error: BaseException) -> list[Any] | None:
    """Pydantic's structured errors, if this is a Pydantic error.

    Imported lazily and defensively so the library keeps no dependency on Pydantic - and so a
    validator that merely *has* an ``errors`` attribute cannot crash the error path.
    """
    errors = getattr(error, "errors", None)
    if not callable(errors):
        return None
    try:
        result = errors()
    except Exception:  # noqa: BLE001 - a validator's own failure must not mask the real error
        return None
    return list(result) if isinstance(result, (list, tuple)) else None


def _key_path_of(issues: list[Any] | None) -> str | None:
    if not issues:
        return None
    first = issues[0]
    location = first.get("loc") if isinstance(first, dict) else None
    if not location:
        return None
    return ".".join(str(segment) for segment in location)


def apply_schema(
    config: dict[str, Any],
    schema: Callable[[dict[str, Any]], Any],
    *,
    strict: bool = False,
    on_warning: Callable[[str], None] | None = None,
) -> Any:
    """Validate *config* and return **the validator's output**.

    Returning the output rather than the input is deliberate: a schema that coerces values or
    fills in defaults therefore changes what ``load`` returns, which is the useful behavior.
    """
    known = _known_fields(schema)
    if known is not None:
        unknown = [key for key in config if key not in known]
        if unknown and strict:
            raise ConfigError(
                "unknown-key",
                f"configuration has unknown keys: {', '.join(unknown)}",
                key_path=unknown[0],
            )
        if unknown and on_warning is not None:
            on_warning(
                f"configuration has unknown keys: {', '.join(unknown)} "
                "(pass strict=True to make this an error)"
            )

    # A Pydantic model class is not callable with a positional dict - BaseModel.__init__ takes
    # keywords - so the one accommodation this module makes is to prefer `model_validate` when
    # the schema offers it. Everything else is called directly, as a plain callable.
    validate = getattr(schema, "model_validate", None)
    if not callable(validate):
        validate = schema

    try:
        return validate(config)
    except ConfigError:
        raise
    except Exception as error:  # noqa: BLE001 - any validator failure is one `kind`
        issues = _issues_of(error)
        raise ConfigError(
            "validation",
            str(error),
            key_path=_key_path_of(issues),
            issues=issues,
        ) from error

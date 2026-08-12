from __future__ import annotations

from typing import Any

import pytest

from config_discovery.errors import ConfigError
from config_discovery.validate import apply_schema


def a_plain_callable(config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config.get("port"), int):
        raise ValueError("port must be an int")
    return config


def test_a_failing_callable_becomes_kind_validation() -> None:
    with pytest.raises(ConfigError) as caught:
        apply_schema({"port": "nope"}, a_plain_callable)
    assert caught.value.kind == "validation"
    assert "port must be an int" in str(caught.value)


def test_the_validators_output_is_what_comes_back() -> None:
    def coercing(config: dict[str, Any]) -> dict[str, Any]:
        return {"port": int(config["port"])}

    # A schema that coerces therefore changes the result. That is the useful behavior.
    assert apply_schema({"port": "5432"}, coercing) == {"port": 5432}


def test_strict_raises_unknown_key_when_the_fields_are_discoverable() -> None:
    class Schema:
        __annotations__ = {"port": int}

        def __call__(self, config: dict[str, Any]) -> dict[str, Any]:
            return config

    with pytest.raises(ConfigError) as caught:
        apply_schema({"port": 1, "extra": True}, Schema(), strict=True)
    assert caught.value.kind == "unknown-key"
    assert caught.value.key_path == "extra"


def test_unknown_keys_only_warn_by_default() -> None:
    class Schema:
        __annotations__ = {"port": int}

        def __call__(self, config: dict[str, Any]) -> dict[str, Any]:
            return config

    collected: list[str] = []
    apply_schema({"port": 1, "extra": True}, Schema(), on_warning=collected.append)
    assert "unknown keys: extra" in collected[0]


def test_a_plain_function_declares_nothing_so_strict_stays_quiet() -> None:
    collected: list[str] = []
    apply_schema(
        {"port": 1, "anything": 2}, a_plain_callable, strict=True, on_warning=collected.append
    )
    assert collected == []


def test_pydantic_errors_are_unpacked_when_pydantic_is_installed() -> None:
    pydantic = pytest.importorskip("pydantic")

    class Settings(pydantic.BaseModel):
        port: int

    with pytest.raises(ConfigError) as caught:
        apply_schema({"port": "nope"}, Settings)
    assert caught.value.kind == "validation"
    assert caught.value.key_path == "port"
    assert caught.value.issues is not None and len(caught.value.issues) == 1

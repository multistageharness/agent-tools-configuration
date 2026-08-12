from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from config_discovery.env import coerce_value, env_key_path, env_layer
from config_discovery.sources import build_sources
from config_discovery.types import Layer, Source


@pytest.mark.parametrize(
    ("raw", "expected", "expected_type"),
    [
        ("5432", 5432, int),
        ("true", True, bool),
        ("[1,2]", [1, 2], list),
        ("5432abc", "5432abc", str),
        # Python's json accepts `true` but not `True`, so `True` stays the string it was
        # written as. That is the intended behavior, not an oversight.
        ("True", "True", str),
    ],
)
def test_coercion(raw: str, expected: Any, expected_type: type) -> None:
    value = coerce_value(raw)
    assert value == expected
    assert isinstance(value, expected_type)


def test_a_quoted_value_stays_a_string() -> None:
    assert coerce_value("5432", was_quoted=True) == "5432"


def test_env_key_path_splits_on_double_underscore_only() -> None:
    assert env_key_path("LOG__LEVEL") == ["log", "level"]
    assert env_key_path("SOME_KEY") == ["some_key"]
    assert env_key_path("A__B__C") == ["a", "b", "c"]


def test_env_layer_nests_and_coerces() -> None:
    assert env_layer({"MYTOOL_LOG__LEVEL": "trace"}, "MYTOOL") == {"log": {"level": "trace"}}
    assert env_layer({"MYTOOL_SOME_KEY": "1"}, "MYTOOL") == {"some_key": 1}


def test_env_layer_ignores_other_prefixes() -> None:
    assert env_layer({"OTHER_LOG__LEVEL": "trace", "PATH": "/usr/bin"}, "MYTOOL") == {}


def test_env_layer_warns_about_an_empty_key_path() -> None:
    collected: list[str] = []
    assert env_layer({"MYTOOL_": "x"}, "MYTOOL", collected.append) == {}
    assert "empty key path" in collected[0]


def _layer(path: str, value: dict[str, Any], precedence: int) -> Layer:
    return Layer(value=value, source=Source(path, "toml", precedence))


class TestBuildSources:
    def test_keys_are_the_top_level_keys_sorted(self) -> None:
        sources = build_sources([_layer("/abs/a/config.toml", {"b": 1, "a": 2}, 2)])
        assert sources[0].keys == ["a", "b"]

    def test_a_file_that_parsed_empty_is_still_reported(self) -> None:
        assert build_sources([_layer("/abs/a/config.toml", {}, 2)])[0].keys == []

    def test_relative_to_rewrites_with_forward_slashes(self) -> None:
        root = Path("/abs/fixture")
        file = root / "project/.config/mytool/config.toml"
        assert (
            build_sources([_layer(str(file), {}, 2)], relative_to=root)[0].path
            == "project/.config/mytool/config.toml"
        )

    def test_labels_are_passed_through(self) -> None:
        layer = Layer(value={"a": 1}, source=Source("<env>", "env", 4))
        assert build_sources([layer], relative_to=Path("/abs/fixture"))[0].path == "<env>"

    def test_application_order_is_preserved_rather_than_sorted(self) -> None:
        # A user-level .env is precedence 3 but belongs inside the user root's block, so it must
        # still be emitted before the project files that outrank it (SPEC section 3.1).
        order = [
            source.precedence
            for source in build_sources(
                [
                    _layer("/u/config.toml", {}, 1),
                    _layer("/u/.env", {}, 3),
                    _layer("/p/config.toml", {}, 2),
                ]
            )
        ]
        assert order == [1, 3, 2]

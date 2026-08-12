from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import pytest

from config_discovery import ConfigError, load

Tree = Callable[[dict[str, str]], Path]


def options(root: Path, **extra: Any) -> dict[str, Any]:
    return {"cwd": root / "project", "home": root / "home", "env": {}, **extra}


def test_local_only(tree: Tree) -> None:
    root = tree(
        {
            "project/.git": "",
            "project/.config/mytool/config.toml": '[log]\nlevel = "debug"\n',
            "home/": "",
        }
    )
    result = load("mytool", **options(root))
    assert result.config == {"log": {"level": "debug"}}
    assert result.found is True
    assert [(s.format, s.precedence, s.keys) for s in result.sources] == [("toml", 2, ["log"])]


def test_user_only(tree: Tree) -> None:
    root = tree({"project/.git": "", "home/.config/mytool/config.toml": '[log]\nlevel = "info"\n'})
    result = load("mytool", **options(root))
    assert result.config == {"log": {"level": "info"}}
    assert result.sources[0].precedence == 1


def test_neither_present_is_not_an_error(tree: Tree) -> None:
    root = tree({"project/.git": "", "home/": ""})
    result = load("mytool", **options(root))
    assert (result.config, result.found, result.sources) == ({}, False, [])


def test_defaults_survive_but_do_not_set_found(tree: Tree) -> None:
    root = tree({"project/.git": "", "home/": ""})
    result = load("mytool", **options(root, defaults={"log": {"level": "warn"}}))
    assert result.config == {"log": {"level": "warn"}}
    assert result.found is False
    assert [s.format for s in result.sources] == ["defaults"]


def test_three_layers_conflict_and_the_losers_are_still_reported(tree: Tree) -> None:
    root = tree(
        {
            "project/.git": "",
            "project/.config/mytool/config.toml": '[log]\nlevel = "debug"\n',
            "home/.config/mytool/config.toml": '[log]\nlevel = "info"\n',
        }
    )
    env = {"MYTOOL_LOG__LEVEL": "trace", "MYTOOL_PORT": "5432"}
    result = load("mytool", **options(root, env=env))
    assert result.config == {"log": {"level": "trace"}, "port": 5432}
    assert [s.precedence for s in result.sources] == [1, 2, 4]


def test_overrides_win_over_everything(tree: Tree) -> None:
    root = tree(
        {
            "project/.git": "",
            "project/.config/mytool/config.toml": '[log]\nlevel = "debug"\n',
            "home/": "",
        }
    )
    result = load(
        "mytool",
        **options(
            root, env={"MYTOOL_LOG__LEVEL": "trace"}, overrides={"log": {"level": "silent"}}
        ),
    )
    assert result.config == {"log": {"level": "silent"}}
    assert result.sources[-1].precedence == 5


def test_the_config_that_crosses_the_boundary_is_a_plain_dict(tree: Tree) -> None:
    root = tree(
        {
            "project/.git": "",
            "project/.config/mytool/config.toml": "[nested]\na = 1\n",
            "home/": "",
        }
    )
    result = load("mytool", **options(root))
    assert type(result.config) is dict
    assert type(result.config["nested"]) is dict


def test_a_package_name_with_a_separator_is_rejected() -> None:
    with pytest.raises(ValueError, match="single path segment"):
        load("../evil")


class TestEveryConfigErrorKind:
    """SPEC section 5's list is closed, and each entry needs a route that reaches it."""

    def test_malformed(self, tree: Tree) -> None:
        root = tree(
            {"project/.git": "", "project/.config/mytool/config.toml": "[log\n", "home/": ""}
        )
        with pytest.raises(ConfigError) as caught:
            load("mytool", **options(root))
        assert caught.value.kind == "malformed"
        assert caught.value.path is not None and caught.value.path.endswith("config.toml")

    def test_duplicate_format(self, tree: Tree) -> None:
        root = tree(
            {
                "project/.git": "",
                "project/.config/mytool/config.yaml": "a: 1\n",
                "project/.config/mytool/config.yml": "a: 2\n",
                "home/": "",
            }
        )
        with pytest.raises(ConfigError) as caught:
            load("mytool", **options(root))
        assert caught.value.kind == "duplicate-format"

    def test_unreadable(self, tree: Tree) -> None:
        root = tree({"project/.git": "", "project/.config/mytool/config.toml/": "", "home/": ""})
        with pytest.raises(ConfigError) as caught:
            load("mytool", **options(root))
        assert caught.value.kind == "unreadable"

    def test_validation_and_unknown_key(self, tree: Tree) -> None:
        root = tree(
            {
                "project/.git": "",
                "project/.config/mytool/config.toml": 'port = "x"\nextra = 1\n',
                "home/": "",
            }
        )

        class Schema:
            __annotations__ = {"port": int}

            def __call__(self, config: dict[str, Any]) -> dict[str, Any]:
                if not isinstance(config["port"], int):
                    raise TypeError("port must be an int")
                return config

        schema = Schema()
        with pytest.raises(ConfigError) as validation:
            load("mytool", **options(root, schema=schema))
        assert validation.value.kind == "validation"

        with pytest.raises(ConfigError) as unknown:
            load("mytool", **options(root, schema=schema, strict=True))
        assert unknown.value.kind == "unknown-key"
        assert unknown.value.key_path == "extra"

    def test_not_found_is_a_kind_that_is_never_raised(self, tree: Tree) -> None:
        root = tree({"project/.git": "", "home/": ""})
        assert load("mytool", **options(root)).found is False
        # It exists so a caller can name the condition (SPEC section 5), not so it can be raised.
        assert ConfigError("not-found", "nothing anywhere").kind == "not-found"

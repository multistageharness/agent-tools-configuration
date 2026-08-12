from __future__ import annotations

from pathlib import Path
from typing import Callable

import pytest

from config_discovery.errors import ConfigError
from config_discovery.loaders import list_config_files, load_one, parse_dotenv

Tree = Callable[[dict[str, str]], Path]

ONE_OF_EVERYTHING = {
    "c/config.toml": 'from_toml = true\nLog_Level = "x"\n[nested]\nvalue = 1\n',
    "c/config.yaml": "from_yaml: true\n",
    "c/config.json": '{"from_json": true}\n',
    "c/config.jsonc": '// a comment\n{"from_jsonc": true /* inline */}\n',
    "c/config.ini": "[section]\nport = 5432\nname = local\n",
    "c/.env": 'FROM__DOTENV=true\nPORT="5432"\n',
}


def test_all_seven_recognized_names_load_from_one_directory(tree: Tree) -> None:
    root = tree(ONE_OF_EVERYTHING)
    merged: dict[str, object] = {}
    for path, fmt in list_config_files(root / "c"):
        merged.update(load_one(path, fmt, env_prefix="MYTOOL"))
    assert merged == {
        "from_toml": True,
        # Dynaconf uppercases top-level keys because it is case-insensitive and the spec is not;
        # the normalization back down is deliberate, and this is the assertion that pins it.
        "log_level": "x",
        "nested": {"value": 1},
        "from_yaml": True,
        "from_json": True,
        "from_jsonc": True,
        # INI is untyped, so its values go through the SPEC section 2.5 coercion.
        "section": {"port": 5432, "name": "local"},
        "from": {"dotenv": True},
        # SPEC section 4.6: a value written inside quotes stays a string.
        "port": "5432",
    }


def test_recognized_files_come_back_in_spec_order(tree: Tree) -> None:
    root = tree(ONE_OF_EVERYTHING)
    assert [path.name for path, _ in list_config_files(root / "c")] == [
        "config.toml",
        "config.yaml",
        "config.json",
        "config.jsonc",
        "config.ini",
        ".env",
    ]


def test_yaml_beside_yml_is_a_duplicate_format_error(tree: Tree) -> None:
    root = tree({"c/config.yaml": "a: 1\n", "c/config.yml": "a: 2\n"})
    with pytest.raises(ConfigError) as caught:
        list_config_files(root / "c")
    assert caught.value.kind == "duplicate-format"
    assert caught.value.path == str(root / "c")


def test_a_profile_file_follows_its_base_file(tree: Tree) -> None:
    root = tree({"c/config.toml": "a = 1\n", "c/config.prod.toml": "a = 2\n"})
    assert [path.name for path, _ in list_config_files(root / "c", "prod")] == [
        "config.toml",
        "config.prod.toml",
    ]


def test_malformed_toml_carries_kind_path_and_line(tree: Tree) -> None:
    root = tree({"c/config.toml": "[log\nlevel = \n"})
    with pytest.raises(ConfigError) as caught:
        load_one(root / "c/config.toml", "toml", env_prefix="MYTOOL")
    assert caught.value.kind == "malformed"
    assert caught.value.path == str(root / "c/config.toml")
    assert caught.value.line == 1


def test_malformed_yaml_is_also_malformed(tree: Tree) -> None:
    root = tree({"c/config.yaml": "a: [1,\nb: 2\n"})
    with pytest.raises(ConfigError) as caught:
        load_one(root / "c/config.yaml", "yaml", env_prefix="MYTOOL")
    assert caught.value.kind == "malformed"


def test_a_read_failure_is_unreadable_not_malformed(tree: Tree) -> None:
    # A directory where a file is expected: a read failure, not a parse one. chmod 000 is not a
    # portable way to express this - an inherited ACL or a privileged user makes it a no-op.
    root = tree({"c/config.toml/": ""})
    with pytest.raises(ConfigError) as caught:
        load_one(root / "c/config.toml", "toml", env_prefix="MYTOOL")
    assert caught.value.kind == "unreadable"


def test_an_empty_file_yields_an_empty_dict_without_error(tree: Tree) -> None:
    root = tree({"c/config.toml": "\n# nothing but a comment\n", "c/config.jsonc": "\n"})
    assert load_one(root / "c/config.toml", "toml", env_prefix="MYTOOL") == {}
    assert load_one(root / "c/config.jsonc", "jsonc", env_prefix="MYTOOL") == {}


def test_a_non_mapping_top_level_is_malformed(tree: Tree) -> None:
    root = tree({"c/config.jsonc": "[1, 2, 3]\n"})
    with pytest.raises(ConfigError) as caught:
        load_one(root / "c/config.jsonc", "jsonc", env_prefix="MYTOOL")
    assert caught.value.kind == "malformed"


def test_the_returned_value_is_a_plain_dict(tree: Tree) -> None:
    root = tree({"c/config.toml": "[nested]\na = 1\n"})
    loaded = load_one(root / "c/config.toml", "toml", env_prefix="MYTOOL")
    # Not a DynaBox: the boundary is plain data, and a leaked wrapper must fail here.
    assert type(loaded) is dict
    assert type(loaded["nested"]) is dict


def test_dynaconf_does_not_see_the_process_environment(
    tree: Tree, monkeypatch: pytest.MonkeyPatch
) -> None:
    # loaders=[] disables Dynaconf's core env loader. Without it, an exported variable becomes
    # configuration and fixture results start depending on the developer's shell.
    monkeypatch.setenv("DYNACONF_SNEAKY", "1")
    monkeypatch.setenv("MYTOOL_SNEAKY", "1")
    root = tree({"c/config.toml": "a = 1\n"})
    assert load_one(root / "c/config.toml", "toml", env_prefix="MYTOOL") == {"a": 1}


class TestParseDotenv:
    def test_strips_the_prefix_when_present(self) -> None:
        assert parse_dotenv("MYTOOL_LOG__LEVEL=trace\nPORT=5432\n", "MYTOOL") == {
            "log": {"level": "trace"},
            "port": 5432,
        }

    def test_quoted_stays_a_string(self) -> None:
        assert parse_dotenv('A="5432"\nB=5432\n', "MYTOOL") == {"a": "5432", "b": 5432}

    def test_ignores_comments_and_honors_export(self) -> None:
        assert parse_dotenv("# comment\nexport A=1\n", "MYTOOL") == {"a": 1}

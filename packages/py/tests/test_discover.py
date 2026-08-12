from __future__ import annotations

from pathlib import Path
from typing import Callable

import pytest

from config_discovery.discover import resolve_project_roots, resolve_user_root
from config_discovery.errors import ConfigError

Tree = Callable[[dict[str, str]], Path]


def test_finds_a_config_two_levels_up(tree: Tree) -> None:
    root = tree({".git": "", ".config/mytool/config.toml": "a = 1\n", "a/b/": ""})
    assert resolve_project_roots(root / "a/b", "mytool", home=root / "nohome") == [
        (root / ".config/mytool").resolve()
    ]


def test_roots_come_back_farthest_ancestor_first(tree: Tree) -> None:
    root = tree(
        {
            ".git": "",
            ".config/mytool/config.toml": "a = 1\n",
            "pkg/.config/mytool/config.toml": "a = 2\n",
            "pkg/src/": "",
        }
    )
    # Order is the contract: the nearest root is last, and last is what wins.
    assert resolve_project_roots(root / "pkg/src", "mytool", home=root / "nohome") == [
        (root / ".config/mytool").resolve(),
        (root / "pkg/.config/mytool").resolve(),
    ]


def test_a_git_directory_between_cwd_and_the_config_stops_the_walk(tree: Tree) -> None:
    root = tree(
        {".config/mytool/config.toml": "a = 1\n", "repo/.git/HEAD": "ref: main\n", "repo/pkg/": ""}
    )
    assert resolve_project_roots(root / "repo/pkg", "mytool", home=root / "nohome") == []


def test_a_git_file_also_stops_the_walk(tree: Tree) -> None:
    # The form git writes for a linked worktree or a submodule. Those are repositories too.
    root = tree(
        {
            ".config/mytool/config.toml": "a = 1\n",
            "repo/.git": "gitdir: /elsewhere/.git/worktrees/w\n",
            "repo/pkg/": "",
        }
    )
    assert resolve_project_roots(root / "repo/pkg", "mytool", home=root / "nohome") == []


def test_stop_dir_is_inclusive(tree: Tree) -> None:
    root = tree({".git": "", "pkg/.config/mytool/config.toml": "a = 1\n", "pkg/src/": ""})
    assert resolve_project_roots(
        root / "pkg/src", "mytool", home=root / "nohome", stop_dir=root / "pkg"
    ) == [(root / "pkg/.config/mytool").resolve()]


def test_home_is_inclusive(tree: Tree) -> None:
    root = tree({".git": "", "home/.config/mytool/config.toml": "a = 1\n", "home/work/": ""})
    assert resolve_project_roots(root / "home/work", "mytool", home=root / "home") == [
        (root / "home/.config/mytool").resolve()
    ]


def test_the_depth_cap_raises(tmp_path: Path) -> None:
    deep = tmp_path.joinpath(*[f"d{index}" for index in range(70)])
    deep.mkdir(parents=True)
    with pytest.raises(ConfigError, match="exceeded 64 directories"):
        resolve_project_roots(deep, "mytool", home=tmp_path / "nohome")


def test_user_root_prefers_an_absolute_xdg(tree: Tree) -> None:
    root = tree({"xdg/mytool/config.toml": "a = 1\n", "home/.config/mytool/config.toml": "a = 2\n"})
    assert resolve_user_root(
        "mytool",
        home=root / "home",
        env={"XDG_CONFIG_HOME": str(root / "xdg")},
        on_warning=lambda _: None,
    ) == root / "xdg/mytool"


def test_user_root_ignores_a_relative_xdg_and_warns(
    tree: Tree, warnings_sink: tuple[list[str], Callable[[str], None]]
) -> None:
    collected, on_warning = warnings_sink
    root = tree({"home/.config/mytool/config.toml": "a = 1\n"})
    resolved = resolve_user_root(
        "mytool", home=root / "home", env={"XDG_CONFIG_HOME": "../cfg"}, on_warning=on_warning
    )
    assert resolved == root / "home/.config/mytool"
    assert len(collected) == 1
    assert "absolute" in collected[0]


def test_user_root_ignores_an_empty_xdg_and_warns(
    tree: Tree, warnings_sink: tuple[list[str], Callable[[str], None]]
) -> None:
    collected, on_warning = warnings_sink
    root = tree({"home/.config/mytool/config.toml": "a = 1\n"})
    assert (
        resolve_user_root(
            "mytool", home=root / "home", env={"XDG_CONFIG_HOME": ""}, on_warning=on_warning
        )
        == root / "home/.config/mytool"
    )
    assert len(collected) == 1


def test_user_root_falls_back_to_home_config_without_warning(
    tree: Tree, warnings_sink: tuple[list[str], Callable[[str], None]]
) -> None:
    collected, on_warning = warnings_sink
    root = tree({"home/.config/mytool/config.toml": "a = 1\n"})
    assert (
        resolve_user_root("mytool", home=root / "home", env={}, on_warning=on_warning)
        == root / "home/.config/mytool"
    )
    assert collected == []


def test_user_root_is_none_when_the_directory_does_not_exist(tree: Tree) -> None:
    root = tree({"home/": ""})
    resolved = resolve_user_root("mytool", home=root / "home", env={}, on_warning=lambda _: None)
    assert resolved is None

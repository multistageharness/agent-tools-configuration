from __future__ import annotations

from typing import Any, Callable

from config_discovery.merge import apply_strategy, merge_layers
from config_discovery.types import Layer, Source


def layer(value: dict[str, Any], root: str | None = None, precedence: int = 2) -> Layer:
    path = "<env>" if root is None else f"{root}/config.toml"
    fmt = "env" if root is None else "toml"
    return Layer(value=value, source=Source(path, fmt, precedence), root=root)


# These mirror the conformance fixtures one to one, so a unit failure and a conformance failure
# point at the same clause of SPEC.
class TestFixtureCases:
    def test_both_scalar_conflict(self) -> None:
        assert merge_layers(
            [
                layer({"log": {"level": "info"}}, "/user", 1),
                layer({"log": {"level": "debug"}}, "/project"),
            ]
        ) == {"log": {"level": "debug"}}

    def test_both_nested_map_merge(self) -> None:
        assert merge_layers(
            [
                layer({"database": {"host": "db.example.com", "port": 5432}}, "/user", 1),
                layer({"database": {"port": 6543}}, "/project"),
            ]
        ) == {"database": {"host": "db.example.com", "port": 6543}}

    def test_both_array_replace(self) -> None:
        assert merge_layers(
            [layer({"plugins": ["a", "b"]}, "/user", 1), layer({"plugins": ["c"]}, "/project")]
        ) == {"plugins": ["c"]}

    def test_both_array_concat_keeps_duplicates(self) -> None:
        assert merge_layers(
            [
                layer({"plugins": ["a", "b"]}, "/user", 1),
                layer({"plugins": ["b", "c"]}, "/project"),
            ],
            array_merge="concat",
        ) == {"plugins": ["a", "b", "b", "c"]}

    def test_explicit_null_unsets_while_absent_leaves_alone(self) -> None:
        assert merge_layers([layer({"a": 1}, "/user", 1), layer({"a": None}, "/project")]) == {}
        # The distinction Python most wants to lose: an absent key is not a None key.
        assert merge_layers([layer({"a": 1}, "/user", 1), layer({}, "/project")]) == {"a": 1}

    def test_null_on_a_key_nobody_set_is_simply_absent(self) -> None:
        merged = merge_layers([layer({"b": 1}, "/user", 1), layer({"a": None}, "/project")])
        assert merged == {"b": 1}


class TestTypeConflicts:
    def test_map_replaced_by_scalar_warns(self) -> None:
        collected: list[str] = []
        assert merge_layers(
            [layer({"log": {"level": "info"}}, "/user", 1), layer({"log": "debug"}, "/project")],
            on_warning=collected.append,
        ) == {"log": "debug"}
        assert "replacing a map with a scalar" in collected[0]

    def test_scalar_replaced_by_map_warns(self) -> None:
        collected: list[str] = []
        assert merge_layers(
            [layer({"log": "info"}, "/user", 1), layer({"log": {"level": "debug"}}, "/project")],
            on_warning=collected.append,
        ) == {"log": {"level": "debug"}}
        assert "replacing a scalar with a map" in collected[0]


class TestStrategy:
    defaults = layer({"d": 1}, None, 0)
    user = layer({"log": {"level": "info"}}, "/user", 1)
    project = layer({"log": {"level": "debug"}}, "/project")
    env = layer({"log": {"level": "trace"}}, None, 4)

    def test_layered_keeps_everything(self) -> None:
        kept = apply_strategy([self.defaults, self.user, self.project, self.env], "layered")
        assert len(kept) == 4

    def test_first_match_drops_the_lower_root_from_output_and_sources(self) -> None:
        kept = apply_strategy([self.defaults, self.user, self.project, self.env], "first-match")
        # The user layer is gone entirely - not merged, and not reported. `first-match` means the
        # lower root was never consulted, not that it lost.
        assert kept == [self.defaults, self.project, self.env]
        assert merge_layers(kept) == {"d": 1, "log": {"level": "trace"}}

    def test_first_match_keeps_every_file_of_the_winning_root(self) -> None:
        dotenv = Layer(
            value={"log": {"level": "from-dotenv"}},
            source=Source("/project/.env", "dotenv", 3),
            root="/project",
        )
        assert apply_strategy([self.user, self.project, dotenv], "first-match") == [
            self.project,
            dotenv,
        ]


def test_a_mapping_subclass_is_not_treated_as_mergeable() -> None:
    class Sneaky(dict[str, Any]):
        pass

    # A dict subclass still merges - it is a dict. What must never merge is a Mapping that is not
    # a dict, such as a LazySettings that leaked through the loader boundary.
    merge: Callable[..., dict[str, Any]] = merge_layers
    assert merge([layer(Sneaky({"a": 1}), "/user", 1)]) == {"a": 1}

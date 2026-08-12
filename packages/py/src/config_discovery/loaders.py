"""File loading - where Dynaconf is actually used.

**Dynaconf is called once per file, never handed the whole ``settings_files`` list.** Given the
list it would apply its own layering, which is not the spec's: it merges lists, it is
case-insensitive, and it has its own idea of which file wins. One file per call reduces it to
what it is genuinely good at - reading TOML, YAML, JSON and INI into a dict behind one API - and
leaves SPEC section 3 to merge.py.

``loaders=[]`` is load-bearing: it disables Dynaconf's *core* loaders, which otherwise read the
process environment into the result. Without it a shell variable would silently become
configuration and fixture results would depend on the developer's terminal.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .env import assign_path, coerce_value, env_key_path
from .errors import ConfigError

#: SPEC section 2.5: the closed, ordered list of recognized file names.
RECOGNIZED_FILES: tuple[tuple[str, str], ...] = (
    ("config.toml", "toml"),
    ("config.yaml", "yaml"),
    ("config.yml", "yaml"),
    ("config.json", "json"),
    ("config.jsonc", "jsonc"),
    ("config.ini", "ini"),
    (".env", "dotenv"),
)

#: Dynaconf's vendored TOML and YAML parsers raise exceptions that carry the position in their
#: message and nowhere else - no ``lineno`` attribute to read. Digging it back out of the text
#: is unlovely, but SPEC section 5 says to report the line where the parser offers one, and the
#: parser does offer it.
_POSITION = re.compile(r"line (\d+)(?:[, ]+column (\d+))?", re.IGNORECASE)


def list_config_files(root: Path, profile: str | None = None) -> list[tuple[Path, str]]:
    """The recognized files present in one directory, in SPEC section 2.5 order.

    That order is also their load order, later entries winning.
    """
    # SPEC section 2.5: a mistake, not an intention. Picking a winner silently would hide it.
    if (root / "config.yaml").exists() and (root / "config.yml").exists():
        raise ConfigError(
            "duplicate-format",
            f"{root}: config.yaml and config.yml cannot both be present",
            path=str(root),
        )

    files: list[tuple[Path, str]] = []
    for name, fmt in RECOGNIZED_FILES:
        path = root / name
        if path.exists():
            files.append((path, fmt))
        if profile:
            # SPEC section 2.6: config.<profile>.<ext> immediately after its base file.
            stem, dot, ext = name.rpartition(".")
            profiled = f"{stem}.{profile}.{ext}" if stem else f"{name}.{profile}"
            candidate = root / profiled
            if candidate.exists():
                files.append((candidate, fmt))
    return files


def _position_of(error: BaseException) -> tuple[int | None, int | None]:
    line = getattr(error, "lineno", None)
    column = getattr(error, "colno", None)
    if isinstance(line, int):
        return line, column if isinstance(column, int) else None
    mark = getattr(error, "problem_mark", None)
    if mark is not None and isinstance(getattr(mark, "line", None), int):
        return mark.line + 1, getattr(mark, "column", 0) + 1
    match = _POSITION.search(str(error))
    if match is None:
        return None, None
    return int(match.group(1)), int(match.group(2)) if match.group(2) else None


def _strip_json_comments(text: str) -> str:
    """Remove ``//`` and ``/* */`` comments that are outside strings.

    Only those two forms, and only outside strings - this is a tolerant pre-pass for `.jsonc`,
    not a JSON5 parser.
    """
    out: list[str] = []
    in_string = False
    index = 0
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""
        if in_string:
            if char == "\\":
                out.append(text[index : index + 2])
                index += 2
                continue
            if char == '"':
                in_string = False
            out.append(char)
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        if char == "/" and nxt == "/":
            while index < len(text) and text[index] != "\n":
                index += 1
            continue
        if char == "/" and nxt == "*":
            index += 2
            while index < len(text):
                if text[index] == "*" and text[index + 1 : index + 2] == "/":
                    break
                index += 1
            index += 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def parse_dotenv(text: str, env_prefix: str) -> dict[str, Any]:
    """A ``.env`` file, mapped by SPEC section 4.6.

    Hand-written rather than delegated, because every ``.env`` reader in every ecosystem strips
    quotes and then cannot tell you it did - and section 4.6 gives quoting meaning: ``PORT=5432``
    is the number, ``PORT="5432"`` is the string.
    """
    result: dict[str, Any] = {}
    marker = f"{env_prefix}_"
    for number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        name, sep, value = line.partition("=")
        if not sep or not name.strip():
            raise ConfigError("malformed", f"{number}: expected KEY=VALUE", line=number)
        name = name.strip()
        value = value.strip()
        quoted = len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]
        if quoted:
            value = value[1:-1]
        # The prefix is stripped when present and simply absent otherwise: a .env inside
        # .config/<packageName>/ is already unambiguous about which package it belongs to.
        bare = name[len(marker) :] if name.upper().startswith(marker) else name
        path = env_key_path(bare)
        if not path:
            continue
        assign_path(result, path, coerce_value(value, was_quoted=quoted))
    return result


def _coerce_ini(value: Any) -> Any:
    """INI is an untyped format - configobj hands back strings for everything.

    SPEC section 2.5 pins the same coercion the env layer uses, so ``port = 5432`` is the number
    in an INI file exactly as it is in the environment. Applied only to INI: the other formats
    carry their own types and must not be second-guessed.
    """
    if isinstance(value, dict):
        return {key: _coerce_ini(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_coerce_ini(item) for item in value]
    if isinstance(value, str):
        return coerce_value(value)
    return value


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (PermissionError, IsADirectoryError, OSError) as error:
        raise ConfigError("unreadable", f"{path}: {error}", path=str(path)) from error


def load_one(path: Path, fmt: str, *, env_prefix: str) -> dict[str, Any]:
    """Read one file into a plain dict."""
    if fmt == "dotenv":
        text = _read_text(path)
        try:
            return parse_dotenv(text, env_prefix)
        except ConfigError as error:
            raise ConfigError(
                "malformed", f"{path}: {error}", path=str(path), line=error.line
            ) from error

    if fmt == "jsonc":
        text = _read_text(path)
        if not text.strip():
            return {}
        try:
            parsed = json.loads(_strip_json_comments(text))
        except ValueError as error:
            line, column = _position_of(error)
            raise ConfigError(
                "malformed", f"{path}: {error}", path=str(path), line=line, column=column
            ) from error
        return _require_mapping(parsed, path)

    # Everything else goes through Dynaconf, one file at a time.
    _read_text(path)  # Surface a permission failure as `unreadable`, not as `malformed`.
    from dynaconf import Dynaconf  # Imported here so `unreadable` never pays for the import.

    try:
        settings = Dynaconf(settings_files=[str(path)], loaders=[])
        raw = dict(settings.as_dict())
    except ConfigError:
        raise
    except Exception as error:  # noqa: BLE001 - every parser failure is one `kind`
        line, column = _position_of(error)
        raise ConfigError(
            "malformed", f"{path}: {error}", path=str(path), line=line, column=column
        ) from error

    # Dynaconf uppercases top-level keys because it is case-insensitive and the spec is not.
    # Nested keys are left alone by Dynaconf, and are left alone here too.
    data = {key.lower(): value for key, value in raw.items()}
    data = {key: _plain(value) for key, value in data.items()}
    return _coerce_ini(data) if fmt == "ini" else data


def _plain(value: Any) -> Any:
    """Strip Dynaconf's DynaBox/BoxList wrappers so a plain dict crosses the boundary."""
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def _require_mapping(parsed: Any, path: Path) -> dict[str, Any]:
    if parsed is None:
        return {}
    if not isinstance(parsed, dict):
        raise ConfigError(
            "malformed",
            f"{path}: top level must be a table, not {type(parsed).__name__}",
            path=str(path),
        )
    return parsed

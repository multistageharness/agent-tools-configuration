//! File loading - where figment is actually used.
//!
//! figment is the parser and nothing more. Each recognized file becomes one figment provider,
//! and `Provider::data` hands back the parsed `Dict`, which is converted straight to
//! [`serde_json::Value`] and handed to [`crate::merge`]. figment's own layering, profiles, and
//! `Figment::merge` chain are not used - see the module comment in `merge.rs` for why.
//!
//! Per format:
//!
//! | format  | provider                                                        |
//! |---------|-----------------------------------------------------------------|
//! | `toml`  | `figment::providers::Toml`, behind the `toml` feature           |
//! | `yaml`  | `figment::providers::Yaml`, behind the `yaml` feature           |
//! | `json`  | `figment::providers::Json`, behind the `json` feature           |
//! | `jsonc` | comment-stripping pre-pass, then `Json::string`                 |
//! | `ini`   | an in-crate parser: figment has no INI provider                 |
//! | `.env`  | `dotenvy`, plus a quote-aware second pass (see [`parse_dotenv`])|
//!
//! **A file whose format feature is disabled at compile time is skipped with a warning, not an
//! error.** That is this crate's one documented deviation from SPEC section 2.5, and it is in
//! the README.

#[cfg(feature = "dotenv")]
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[cfg(any(feature = "toml", feature = "yaml", feature = "json"))]
use figment::providers::Format as _;
use serde_json::{Map, Value};

use crate::error::Error;

/// A recognized configuration file and the format it is read as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileRef {
    pub path: PathBuf,
    pub format: &'static str,
}

/// SPEC section 2.5: the closed, ordered list. That order is also the load order within one
/// directory, later entries winning.
pub(crate) const RECOGNIZED_FILES: &[(&str, &str)] = &[
    ("config.toml", "toml"),
    ("config.yaml", "yaml"),
    ("config.yml", "yaml"),
    ("config.json", "json"),
    ("config.jsonc", "jsonc"),
    ("config.ini", "ini"),
    (".env", "dotenv"),
];

/// The recognized files present in one config directory, in SPEC section 2.5 order.
pub(crate) fn list_config_files(
    root: &Path,
    profile: Option<&str>,
) -> Result<Vec<FileRef>, Error> {
    // SPEC section 2.5: a mistake, not an intention. Picking a winner silently would hide it.
    if root.join("config.yaml").exists() && root.join("config.yml").exists() {
        return Err(Error::DuplicateFormat {
            path: root.to_path_buf(),
        });
    }

    let mut files = Vec::new();
    for &(name, format) in RECOGNIZED_FILES {
        let path = root.join(name);
        if path.exists() {
            files.push(FileRef {
                path,
                format,
            });
        }
        if let Some(profile) = profile {
            // SPEC section 2.6: config.<profile>.<ext> immediately after its base file.
            let profiled = root.join(with_profile(name, profile));
            if profiled.exists() {
                files.push(FileRef {
                    path: profiled,
                    format,
                });
            }
        }
    }
    Ok(files)
}

fn with_profile(name: &str, profile: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{}.{profile}{}", &name[..dot], &name[dot..]),
        _ => format!("{name}.{profile}"),
    }
}

/// Whether this build can read `format`. A file in a format that was compiled out is skipped
/// with a warning rather than failing the load.
// Not `matches!`: under --all-features every arm evaluates to true and clippy cannot see that
// the arms differ by feature. A build with only some features on needs them distinct.
#[allow(clippy::match_like_matches_macro)]
pub(crate) fn format_enabled(format: &str) -> bool {
    match format {
        "toml" => cfg!(feature = "toml"),
        "yaml" => cfg!(feature = "yaml"),
        "json" | "jsonc" => cfg!(feature = "json"),
        "ini" => cfg!(feature = "ini"),
        "dotenv" => cfg!(feature = "dotenv"),
        _ => false,
    }
}

fn read_to_string(path: &Path) -> Result<String, Error> {
    std::fs::read_to_string(path).map_err(|source| Error::unreadable(path, source))
}

fn malformed(path: &Path, source: impl std::error::Error + Send + Sync + 'static) -> Error {
    let text = source.to_string();
    let (line, column) = position_of(&text);
    Error::Malformed {
        path: path.to_path_buf(),
        line,
        column,
        source: Box::new(source),
    }
}

/// figment reports a parse position inside the message and nowhere machine-readable, so this
/// digs it back out. SPEC section 5 asks for the line where the parser offers one.
fn position_of(message: &str) -> (Option<usize>, Option<usize>) {
    let lowered = message.to_ascii_lowercase();
    let mut line = None;
    let mut column = None;
    if let Some(index) = lowered.find("line ") {
        line = parse_leading_number(&lowered[index + 5..]);
    }
    if let Some(index) = lowered.find("column ") {
        column = parse_leading_number(&lowered[index + 7..]);
    }
    (line, column)
}

fn parse_leading_number(text: &str) -> Option<usize> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Read one file into a JSON value with its original key case intact.
pub(crate) fn load_one(file: &FileRef, env_prefix: &str) -> Result<Map<String, Value>, Error> {
    // Read first, always, and never hand figment a path.
    //
    // `Toml::file(path)` and its siblings treat an unreadable file the way figment treats every
    // optional source: as no data, returning Ok with an empty dict. That is right for figment,
    // where a provider is allowed not to exist, and wrong here - SPEC section 5 requires an
    // `unreadable` error naming the path, and silently reading nothing is exactly the failure
    // mode the spec exists to prevent. Reading here also means one error surface for every
    // format instead of two.
    let text = read_to_string(&file.path)?;
    if text.trim().is_empty() {
        return Ok(Map::new());
    }

    match file.format {
        #[cfg(feature = "toml")]
        "toml" => provider_data(&figment::providers::Toml::string(&text), &file.path),

        #[cfg(feature = "yaml")]
        "yaml" => provider_data(&figment::providers::Yaml::string(&text), &file.path),

        #[cfg(feature = "json")]
        "json" => provider_data(&figment::providers::Json::string(&text), &file.path),

        #[cfg(feature = "json")]
        "jsonc" => {
            let stripped = strip_json_comments(&text);
            if stripped.trim().is_empty() {
                return Ok(Map::new());
            }
            provider_data(&figment::providers::Json::string(&stripped), &file.path)
        }

        #[cfg(feature = "ini")]
        "ini" => parse_ini(&text),

        #[cfg(feature = "dotenv")]
        "dotenv" => parse_dotenv(&text, env_prefix, &file.path),

        other => {
            let _ = env_prefix;
            Err(Error::Malformed {
                path: file.path.clone(),
                line: None,
                column: None,
                source: format!("format {other} is not compiled into this build").into(),
            })
        }
    }
}

/// Take a figment provider's parsed data for the default profile and convert it to JSON.
///
/// `Provider::data` is figment used as a parser and nothing else - no profile selection, no
/// merge chain, no `Figment`.
#[cfg(any(feature = "toml", feature = "yaml", feature = "json"))]
fn provider_data(
    provider: &dyn figment::Provider,
    path: &Path,
) -> Result<Map<String, Value>, Error> {
    let data = provider.data().map_err(|error| {
        let text = error.to_string();
        let (line, column) = position_of(&text);
        Error::Malformed {
            path: path.to_path_buf(),
            line,
            column,
            source: Box::new(error),
        }
    })?;

    let dict = data
        .into_iter()
        .find(|(profile, _)| *profile == figment::Profile::Default)
        .map(|(_, dict)| dict)
        .unwrap_or_default();

    let value = serde_json::to_value(dict).map_err(|source| malformed(path, source))?;
    match value {
        Value::Object(map) => Ok(canonical_map(map)),
        Value::Null => Ok(Map::new()),
        other => Err(Error::Malformed {
            path: path.to_path_buf(),
            line: None,
            column: None,
            source: format!("top level must be a table, not {}", type_name(&other)).into(),
        }),
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "a table",
    }
}

/// Give every source one numeric representation: an integer when the value is integral.
///
/// Without it a `5432` parsed from TOML and a `5432` parsed from JSON can land in different
/// [`serde_json::Number`] variants, and a caller comparing them - or a fixture comparing
/// `5432` with `5432.0` - sees a difference that is not there.
pub(crate) fn canonical_value(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(canonical_map(map)),
        Value::Array(items) => Value::Array(items.into_iter().map(canonical_value).collect()),
        Value::Number(number) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 9.007_199_254_740_992e15 => {
                Value::Number((float as i64).into())
            }
            _ => Value::Number(number),
        },
        other => other,
    }
}

pub(crate) fn canonical_map(map: Map<String, Value>) -> Map<String, Value> {
    map.into_iter()
        .map(|(key, value)| (key, canonical_value(value)))
        .collect()
}

#[cfg(feature = "json")]
/// Remove `//` and `/* */` comments that are outside strings. Only those two forms, and only
/// outside strings: a tolerant pre-pass for `.jsonc`, not a JSON5 parser.
pub(crate) fn strip_json_comments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut index = 0;
    while index < bytes.len() {
        let char = bytes[index] as char;
        let next = bytes.get(index + 1).map(|byte| *byte as char);
        match (in_string, char, next) {
            (true, '\\', _) => {
                out.push(char);
                if let Some(next) = next {
                    out.push(next);
                }
                index += 2;
            }
            (true, '"', _) => {
                in_string = false;
                out.push(char);
                index += 1;
            }
            (true, _, _) => {
                out.push(char);
                index += 1;
            }
            (false, '"', _) => {
                in_string = true;
                out.push(char);
                index += 1;
            }
            (false, '/', Some('/')) => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            (false, '/', Some('*')) => {
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                index += 2;
            }
            _ => {
                out.push(char);
                index += 1;
            }
        }
    }
    out
}

/// A small INI reader: `[section]` headers, `key = value`, `#` and `;` comments.
///
/// figment has no INI provider, so this is in-crate. INI is an untyped format, so SPEC section
/// 2.5 pins the same coercion the env layer uses.
#[cfg(feature = "ini")]
pub(crate) fn parse_ini(text: &str) -> Result<Map<String, Value>, Error> {
    let mut root = Map::new();
    let mut section: Option<String> = None;

    for (number, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            let name = rest.strip_suffix(']').ok_or_else(|| Error::Malformed {
                path: PathBuf::new(),
                line: Some(number + 1),
                column: None,
                source: "unterminated section header".into(),
            })?;
            section = Some(name.trim().to_string());
            root.entry(name.trim().to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            continue;
        }
        let (name, value) = line.split_once('=').ok_or_else(|| Error::Malformed {
            path: PathBuf::new(),
            line: Some(number + 1),
            column: None,
            source: "expected key = value".into(),
        })?;
        let coerced = crate::env::coerce_value(value.trim(), false);
        match &section {
            Some(section) => {
                if let Some(Value::Object(table)) = root.get_mut(section) {
                    table.insert(name.trim().to_string(), coerced);
                }
            }
            None => {
                root.insert(name.trim().to_string(), coerced);
            }
        }
    }
    Ok(root)
}

/// A `.env` file, mapped by SPEC section 4.6.
///
/// dotenvy parses it, but dotenvy - like every other `.env` reader in every ecosystem - strips
/// surrounding quotes and cannot tell you it did. Section 4.6 gives quoting meaning:
/// `PORT=5432` is the number, `PORT="5432"` is the string. So the raw lines get a second pass to
/// record which keys were written quoted.
#[cfg(feature = "dotenv")]
pub(crate) fn parse_dotenv(
    text: &str,
    env_prefix: &str,
    path: &Path,
) -> Result<Map<String, Value>, Error> {
    use std::io::Cursor;

    let quoted: BTreeMap<String, bool> = text
        .lines()
        .filter_map(|raw_line| {
            let line = raw_line.trim().strip_prefix("export ").unwrap_or(raw_line.trim());
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (name, value) = line.split_once('=')?;
            let value = value.trim();
            let is_quoted = value.len() >= 2
                && (value.starts_with('"') || value.starts_with('\''))
                && value.ends_with(value.chars().next().unwrap());
            Some((name.trim().to_string(), is_quoted))
        })
        .collect();

    let mut out = Map::new();
    let marker = format!("{env_prefix}_");
    for entry in dotenvy::from_read_iter(Cursor::new(text.as_bytes())) {
        let (name, value) = entry.map_err(|source| malformed(path, source))?;
        // The prefix is stripped when present and simply absent otherwise: a .env inside
        // .config/<packageName>/ is already unambiguous about which package it belongs to.
        let bare = if name.to_ascii_uppercase().starts_with(&marker) {
            name[marker.len()..].to_string()
        } else {
            name.clone()
        };
        let path_segments = crate::env::env_key_path(&bare);
        if path_segments.is_empty() {
            continue;
        }
        let was_quoted = quoted.get(&name).copied().unwrap_or(false);
        crate::env::assign_path(
            &mut out,
            &path_segments,
            crate::env::coerce_value(&value, was_quoted),
        );
    }
    Ok(out)
}

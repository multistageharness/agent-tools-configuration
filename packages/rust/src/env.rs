//! The environment-variable layer - SPEC section 4.5 - and the name mapping `.env` files share
//! with it (SPEC section 4.6).
//!
//! **`figment::providers::Env` is deliberately not used.** `Env::prefixed(..).split("__")` gets
//! close, but two things do not line up: figment applies its own coercion, which is not the
//! spec's parse-as-JSON-or-keep-the-string rule, and `Env` reads the *process* environment, so a
//! fixture's result would depend on the developer's shell. If a later reader "simplifies" this
//! module back onto `Env`, `env-var-beats-files` is what will break, and it will break by
//! producing the string `"5432"` where the number `5432` is required.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::loaders::canonical_value;

/// Map a variable name, prefix already stripped, to a key path.
///
/// Lowercase, split on `__`, and leave a single `_` alone: `SOME_KEY` is the single key
/// `some_key`, not `some.key`.
pub(crate) fn env_key_path(name: &str) -> Vec<String> {
    name.to_ascii_lowercase()
        .split("__")
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

/// SPEC section 4.5 step 5: parse as JSON, keep the raw string when that fails.
///
/// `was_quoted` short-circuits it for `.env` values written inside quotes, which section 4.6
/// keeps as strings.
pub(crate) fn coerce_value(raw: &str, was_quoted: bool) -> Value {
    if was_quoted {
        return Value::String(raw.to_string());
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(value) => canonical_value(value),
        Err(_) => Value::String(raw.to_string()),
    }
}

/// Write `value` at `path`, creating objects along the way and replacing non-objects.
pub(crate) fn assign_path(target: &mut Map<String, Value>, path: &[String], value: Value) {
    let Some((leaf, parents)) = path.split_last() else {
        return;
    };
    let mut node = target;
    for segment in parents {
        let entry = node
            .entry(segment.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        node = entry.as_object_mut().expect("just ensured it is an object");
    }
    node.insert(leaf.clone(), value);
}

/// Layer 4.
///
/// `env` is a parameter and is never `std::env::vars()` in here: the probe and every test depend
/// on an exported `MYTOOL_*` in the developer's shell being unable to reach this function.
pub(crate) fn env_layer(
    env: &BTreeMap<String, String>,
    prefix: &str,
    warn: &dyn Fn(&str),
) -> Map<String, Value> {
    let mut out = Map::new();
    let marker = format!("{prefix}_");
    for (name, raw) in env {
        let Some(rest) = name.strip_prefix(&marker) else {
            continue;
        };
        let path = env_key_path(rest);
        if path.is_empty() {
            warn(&format!("ignoring {name}: it maps to an empty key path"));
            continue;
        }
        assign_path(&mut out, &path, coerce_value(raw, false));
    }
    out
}

//! The `sources` output - SPEC section 7.
//!
//! The only thing standing between a user who expected `debug` and an afternoon of guessing
//! which of six layers set `trace`, so every source that was read is listed, winners and losers
//! alike.

use std::path::Path;

use serde::Serialize;

use crate::merge::Layer;

/// One contributing input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Source {
    /// Absolute at runtime, rewritten by `relative_to`. For the layers that are not files it is
    /// the literal `<defaults>`, `<env>` or `<overrides>`.
    pub path: String,
    /// One of `toml`, `yaml`, `json`, `jsonc`, `ini`, `dotenv`, `env`, `defaults`, `overrides`.
    pub format: String,
    /// The layer number from the SPEC section 3.1 table.
    pub precedence: u8,
    /// The top-level keys this source contributed, sorted. Empty - and serialized as `[]` - for
    /// a file that parsed empty.
    pub keys: Vec<String>,
}

/// Emit entries in **application order** - the order the layers were merged, lowest effective
/// priority first (SPEC section 3.1).
///
/// That is ascending precedence with one documented exception: a root's `.env` (precedence 3)
/// belongs inside that root's block, so a user-level `.env` still loses to a project-local
/// `config.toml`. Sorting this list by precedence would reorder it into something that does not
/// describe what happened.
pub(crate) fn build_sources(layers: &[Layer], relative_to: Option<&Path>) -> Vec<Source> {
    layers
        .iter()
        .map(|layer| Source {
            path: rewrite_path(&layer.source.path, relative_to),
            format: layer.source.format.clone(),
            precedence: layer.source.precedence,
            keys: layer.value.keys().cloned().collect(),
        })
        .collect()
}

fn rewrite_path(path: &str, relative_to: Option<&Path>) -> String {
    // <defaults>, <env> and <overrides> are labels, not paths, and are passed through.
    let candidate = Path::new(path);
    let Some(root) = relative_to else {
        return path.to_string();
    };
    if !candidate.is_absolute() {
        return path.to_string();
    }
    match candidate.strip_prefix(root) {
        // Forward slashes on every platform - on Windows this is not a no-op.
        Ok(relative) => relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
        // Outside the fixture root: stay absolute rather than emit a ../../ climb that no
        // expected.json could match.
        Err(_) => path.replace('\\', "/"),
    }
}

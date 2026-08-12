//! Load a program's configuration from `./.config/<package_name>/`, walking up from the working
//! directory, with a fallback to `~/.config/<package_name>/`, layered so project-local values
//! win.
//!
//! Behavior is defined by `packages/spec/SPEC.md`, the contract five language implementations
//! share. No figment type appears in this crate's public API: figment is the parser, and that is
//! an implementation detail documented in `loaders.rs` and `merge.rs`.
//!
//! ```no_run
//! # fn main() -> Result<(), config_discovery::Error> {
//! let loaded = config_discovery::load_default("mytool")?;
//! if !loaded.found {
//!     eprintln!("no config file found; using defaults");
//! }
//! for source in &loaded.sources {
//!     eprintln!("{} {}", source.precedence, source.path);
//! }
//! # Ok(())
//! # }
//! ```
//!
//! # Features
//!
//! `default = ["toml", "json"]`. A file whose format feature is disabled at compile time is
//! **skipped with a warning**, not an error - see the README. The conformance probe builds with
//! `--all-features`, so a fixture can never pass because a format was compiled out.

#![deny(missing_docs)]

mod discover;
mod env;
mod error;
mod loaders;
mod merge;
mod options;
mod sources;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde_json::Value;

pub use crate::error::Error;
pub use crate::merge::{ArrayMerge, Strategy};
pub use crate::options::{Options, OptionsBuilder};
pub use crate::sources::Source;

use crate::merge::{apply_strategy, merge_layers, Layer, MergeOptions};

/// The result of a successful load - SPEC section 7.
#[derive(Debug, Clone)]
pub struct Loaded {
    config: Value,
    /// True when at least one recognized *file* contributed. Defaults and environment variables
    /// do not set it.
    pub found: bool,
    /// Application order, lowest effective priority first.
    pub sources: Vec<Source>,
}

impl Loaded {
    /// The merged configuration.
    pub fn config(&self) -> &Value {
        &self.config
    }

    /// Deserialize the merged configuration into `T`.
    ///
    /// A type carrying `#[serde(deny_unknown_fields)]` turns an unrecognized key into
    /// [`Error::UnknownKey`]; without it, serde ignores unknown keys and so does this. That is
    /// the mechanism `strict` relies on, and it is why the README says so rather than promising
    /// a check this crate cannot perform.
    pub fn extract<T: DeserializeOwned>(&self) -> Result<T, Error> {
        serde_json::from_value(self.config.clone()).map_err(|source| {
            let message = source.to_string();
            if message.contains("unknown field") {
                return Error::UnknownKey {
                    key_path: unknown_field_of(&message).unwrap_or_else(|| message.clone()),
                };
            }
            Error::Validation {
                key_path: None,
                message,
            }
        })
    }
}

fn unknown_field_of(message: &str) -> Option<String> {
    let after = message.split("unknown field `").nth(1)?;
    Some(after.split('`').next()?.to_string())
}

/// Load `package_name`'s configuration with default options.
pub fn load_default(package_name: &str) -> Result<Loaded, Error> {
    load(package_name, Options::default())
}

/// Load `package_name`'s configuration.
///
/// Finding nothing is not an error: the result is the defaults with `found: false` and an empty
/// `sources`. Finding something broken **is** an error - naming the path - because silently
/// falling back to defaults when a YAML file has a tab in it is how a typo becomes an incident.
pub fn load(package_name: &str, options: Options) -> Result<Loaded, Error> {
    if package_name.is_empty()
        || package_name.contains('/')
        || package_name.contains('\\')
        || package_name == "."
        || package_name == ".."
    {
        return Err(Error::Validation {
            key_path: None,
            message: format!("package name {package_name:?} must be a single path segment"),
        });
    }

    let warn = options.on_warning.as_ref();
    // The ambient process is read in exactly these three places, and each is overridable.
    let cwd = match options.cwd.clone() {
        Some(cwd) => cwd,
        None => std::env::current_dir().map_err(|source| Error::unreadable(".", source))?,
    };
    let home = options.home.clone().unwrap_or_else(home_directory);
    let env: BTreeMap<String, String> = options
        .env
        .clone()
        .unwrap_or_else(|| std::env::vars().collect());
    let prefix = options.env_prefix.clone().unwrap_or_else(|| {
        package_name
            .to_ascii_uppercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    });

    let user_root = discover::resolve_user_root(package_name, &home, &env, warn);
    let project_roots = discover::resolve_project_roots(
        &cwd,
        package_name,
        &discover::WalkOptions {
            home: Some(home.clone()),
            stop_dir: options.stop_dir.clone(),
        },
    )?;

    let mut blocks: Vec<(PathBuf, u8)> = Vec::new();
    if let Some(root) = user_root {
        blocks.push((root, 1));
    }
    blocks.extend(project_roots.into_iter().map(|root| (root, 2)));

    let mut layers: Vec<Layer> = Vec::new();
    if !options.defaults.is_empty() {
        layers.push(Layer {
            value: loaders::canonical_map(options.defaults.clone()),
            source: Source {
                path: "<defaults>".into(),
                format: "defaults".into(),
                precedence: 0,
                keys: Vec::new(),
            },
            root: None,
        });
    }

    for (root, precedence) in &blocks {
        for file in loaders::list_config_files(root, options.profile.as_deref())? {
            if !loaders::format_enabled(file.format) {
                warn(&format!(
                    "skipping {}: the {} feature is not enabled in this build",
                    file.path.display(),
                    file.format
                ));
                continue;
            }
            let value = loaders::load_one(&file, &prefix)?;
            layers.push(Layer {
                value,
                source: Source {
                    path: file.path.to_string_lossy().into_owned(),
                    format: file.format.to_string(),
                    // SPEC section 3.1: a .env is its own layer, applied inside its root's block.
                    precedence: if file.format == "dotenv" { 3 } else { *precedence },
                    keys: Vec::new(),
                },
                root: Some(root.to_string_lossy().into_owned()),
            });
        }
    }

    let from_env = env::env_layer(&env, &prefix, warn);
    if !from_env.is_empty() {
        layers.push(Layer {
            value: from_env,
            source: Source {
                path: "<env>".into(),
                format: "env".into(),
                precedence: 4,
                keys: Vec::new(),
            },
            root: None,
        });
    }
    if !options.overrides.is_empty() {
        layers.push(Layer {
            value: loaders::canonical_map(options.overrides.clone()),
            source: Source {
                path: "<overrides>".into(),
                format: "overrides".into(),
                precedence: 5,
                keys: Vec::new(),
            },
            root: None,
        });
    }

    let contributing = apply_strategy(layers, options.strategy);
    let merged = merge_layers(
        &contributing,
        &MergeOptions {
            array_merge: options.array_merge,
            warn,
        },
    );

    if options.strict {
        // The only strictness this crate can apply without a target type is to say so: the real
        // check happens in `extract` against `#[serde(deny_unknown_fields)]`.
        warn("strict: unknown keys are reported by extract() against a type with #[serde(deny_unknown_fields)]");
    }

    Ok(Loaded {
        found: contributing.iter().any(|layer| layer.root.is_some()),
        sources: sources::build_sources(&contributing, options.relative_to.as_deref()),
        config: Value::Object(merged),
    })
}

fn home_directory() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

//! Merge semantics - SPEC section 4.
//!
//! **The merge is hand-written here rather than delegated to figment, and the reason is arrays.**
//! figment's `Figment::merge` chain replaces or extends arrays depending on the provider and the
//! profile mechanism, and there is no switch that makes it always replace with an opt-in concat.
//! Layer precedence is also ours to define (SPEC section 3.1), including the rule that a root's
//! `.env` applies inside that root's block - which figment's flat merge chain cannot express.
//!
//! So figment is used purely as a parser (see `loaders.rs`), exactly as the other four language
//! packages use their libraries, and the values it produces are merged over
//! [`serde_json::Value`]. That representation is deliberate: it is the model SPEC's output
//! contract is written in, and it makes the null-versus-absent distinction of section 4.4 free -
//! `Option<&Value>` for absent, `Value::Null` for an explicit null, two different types that
//! cannot be conflated.

use serde_json::{Map, Value};

use crate::sources::Source;

/// One layer on its way into the merge, with the source it will be reported as.
#[derive(Debug, Clone)]
pub(crate) struct Layer {
    pub value: Map<String, Value>,
    pub source: Source,
    /// The config directory this layer came from, for `first-match`. `None` for the layers that
    /// belong to no root: defaults, env, overrides.
    pub root: Option<String>,
}

/// How arrays combine (SPEC section 4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ArrayMerge {
    /// The higher layer's array is the result. The default.
    #[default]
    Replace,
    /// Append the higher layer's elements onto the lower layer's, with no deduplication.
    Concat,
}

/// Which roots contribute (SPEC section 3.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Strategy {
    /// Every resolved root contributes. The default.
    #[default]
    Layered,
    /// Only the highest-precedence root that contained a recognized file contributes.
    FirstMatch,
}

pub(crate) struct MergeOptions<'a> {
    pub array_merge: ArrayMerge,
    pub warn: &'a dyn Fn(&str),
}

fn merge_into(
    lower: &mut Map<String, Value>,
    higher: &Map<String, Value>,
    opts: &MergeOptions<'_>,
    path: &str,
) {
    for (key, value) in higher {
        let at = if path.is_empty() {
            key.clone()
        } else {
            format!("{path}.{key}")
        };

        // SPEC section 4.4. Absent is not null: a key the higher layer never mentions is not in
        // this loop at all, and a key set to null asks for a delete.
        if value.is_null() {
            lower.remove(key);
            continue;
        }

        match (lower.get_mut(key), value) {
            (Some(Value::Object(existing)), Value::Object(incoming)) => {
                merge_into(existing, incoming, opts, &at);
            }
            (Some(Value::Array(existing)), Value::Array(incoming)) => {
                // SPEC section 4.3: replace by default; concat appends and never deduplicates.
                match opts.array_merge {
                    ArrayMerge::Replace => *existing = incoming.clone(),
                    ArrayMerge::Concat => existing.extend(incoming.iter().cloned()),
                }
            }
            (Some(existing), incoming) => {
                if existing.is_object() != incoming.is_object() {
                    let was = if existing.is_object() { "a map" } else { "a scalar" };
                    let now = if incoming.is_object() { "a map" } else { "a scalar" };
                    (opts.warn)(&format!(
                        "{at}: replacing {was} with {now} (SPEC section 4.2)"
                    ));
                }
                *existing = incoming.clone();
            }
            (None, incoming) => {
                lower.insert(key.clone(), incoming.clone());
            }
        }
    }
}

/// Fold the layers lowest precedence first.
pub(crate) fn merge_layers(layers: &[Layer], opts: &MergeOptions<'_>) -> Map<String, Value> {
    let mut result = Map::new();
    for layer in layers {
        merge_into(&mut result, &layer.value, opts, "");
    }
    result
}

/// SPEC section 3.2.
///
/// Under [`Strategy::FirstMatch`] only the highest-precedence root that contributed a file
/// survives - the lower roots are dropped from the merge **and** from `sources`, because the
/// option means "the others were never consulted", not "the others lost". The rootless layers -
/// defaults, env, overrides - always survive: the option scopes the file layers only.
pub(crate) fn apply_strategy(layers: Vec<Layer>, strategy: Strategy) -> Vec<Layer> {
    if strategy != Strategy::FirstMatch {
        return layers;
    }
    let winning = layers
        .iter()
        .filter_map(|layer| layer.root.as_deref())
        .next_back()
        .map(str::to_string);
    layers
        .into_iter()
        .filter(|layer| match (&layer.root, &winning) {
            (None, _) => true,
            (Some(root), Some(winning)) => root == winning,
            (Some(_), None) => false,
        })
        .collect()
}

//! The option surface - SPEC section 6.
//!
//! Every ambient input - the working directory, the home directory, the environment - has a
//! builder method that replaces it, which is what makes the conformance probe and every test in
//! this crate hermetic.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::merge::{ArrayMerge, Strategy};

/// Everything `load` can be told.
pub struct Options {
    pub(crate) strategy: Strategy,
    pub(crate) array_merge: ArrayMerge,
    pub(crate) stop_dir: Option<PathBuf>,
    pub(crate) env_prefix: Option<String>,
    pub(crate) profile: Option<String>,
    pub(crate) strict: bool,
    pub(crate) home: Option<PathBuf>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) env: Option<BTreeMap<String, String>>,
    pub(crate) defaults: Map<String, Value>,
    pub(crate) overrides: Map<String, Value>,
    pub(crate) relative_to: Option<PathBuf>,
    pub(crate) on_warning: Box<dyn Fn(&str)>,
}

impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options")
            .field("strategy", &self.strategy)
            .field("array_merge", &self.array_merge)
            .field("stop_dir", &self.stop_dir)
            .field("env_prefix", &self.env_prefix)
            .field("profile", &self.profile)
            .field("strict", &self.strict)
            .field("home", &self.home)
            .field("cwd", &self.cwd)
            .field("relative_to", &self.relative_to)
            .finish_non_exhaustive()
    }
}

impl Default for Options {
    fn default() -> Self {
        Options {
            strategy: Strategy::default(),
            array_merge: ArrayMerge::default(),
            stop_dir: None,
            env_prefix: None,
            profile: None,
            strict: false,
            home: None,
            cwd: None,
            env: None,
            defaults: Map::new(),
            overrides: Map::new(),
            relative_to: None,
            // Diagnostics go to stderr, never stdout: PROBE.md section 4 depends on it, and so
            // does any consumer piping a program's output.
            on_warning: Box::new(|message| eprintln!("warning: {message}")),
        }
    }
}

impl Options {
    /// A fresh builder.
    pub fn builder() -> OptionsBuilder {
        OptionsBuilder {
            options: Options::default(),
        }
    }
}

/// Builds [`Options`].
#[derive(Debug, Default)]
pub struct OptionsBuilder {
    options: Options,
}

macro_rules! setter {
    ($(#[$meta:meta])* $name:ident, $field:ident, $type:ty) => {
        $(#[$meta])*
        #[must_use]
        pub fn $name(mut self, value: $type) -> Self {
            self.options.$field = value;
            self
        }
    };
}

impl OptionsBuilder {
    setter!(
        /// Whether every root contributes or only the nearest one with a file (SPEC section 3.2).
        strategy, strategy, Strategy
    );
    setter!(
        /// How arrays combine (SPEC section 4.3).
        array_merge, array_merge, ArrayMerge
    );
    setter!(
        /// Promote an unknown key from a warning to an error (SPEC section 5).
        strict, strict, bool
    );
    setter!(
        /// Layer 0.
        defaults, defaults, Map<String, Value>
    );
    setter!(
        /// Layer 5.
        overrides, overrides, Map<String, Value>
    );

    /// An extra, inclusive stop condition for the upward walk (SPEC section 2.3).
    #[must_use]
    pub fn stop_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.options.stop_dir = Some(dir.into());
        self
    }

    /// Override the prefix for the environment layer (SPEC section 4.5).
    #[must_use]
    pub fn env_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.options.env_prefix = Some(prefix.into());
        self
    }

    /// Also load `config.<profile>.<ext>` beside each base file (SPEC section 2.6).
    #[must_use]
    pub fn profile(mut self, profile: impl Into<String>) -> Self {
        self.options.profile = Some(profile.into());
        self
    }

    /// Override the home directory the user-level root resolves under.
    #[must_use]
    pub fn home(mut self, home: impl Into<PathBuf>) -> Self {
        self.options.home = Some(home.into());
        self
    }

    /// Override the directory the upward walk starts from.
    #[must_use]
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.options.cwd = Some(cwd.into());
        self
    }

    /// Replace the environment the prefixed layer reads. An explicitly empty map means "no
    /// environment", which is different from not calling this at all.
    #[must_use]
    pub fn env(mut self, env: BTreeMap<String, String>) -> Self {
        self.options.env = Some(env);
        self
    }

    /// Emit `Source::path` relative to `dir`, forward-slashed. Used by the conformance probe.
    #[must_use]
    pub fn relative_to(mut self, dir: impl Into<PathBuf>) -> Self {
        self.options.relative_to = Some(dir.into());
        self
    }

    /// Route diagnostics. The default writes to stderr.
    #[must_use]
    pub fn on_warning(mut self, warn: impl Fn(&str) + 'static) -> Self {
        self.options.on_warning = Box::new(warn);
        self
    }

    /// Finish.
    pub fn build(self) -> Options {
        self.options
    }
}

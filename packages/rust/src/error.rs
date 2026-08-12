//! The error model of SPEC section 5.
//!
//! Every failure carries a kind from a closed list, so callers match on the variant - and the
//! conformance suite compares [`Error::kind`] - rather than on message text, which differs per
//! parser and per language.

use std::fmt;
use std::path::{Path, PathBuf};

/// Everything `load` can fail with.
///
/// `#[non_exhaustive]` so adding a variant later is not a breaking change. The wrapped parser
/// error is reachable through [`std::error::Error::source`] but never appears in a variant's
/// public type, so a figment major bump is not a breaking change here either.
#[non_exhaustive]
#[derive(Debug)]
pub enum Error {
    /// No recognized file at any root. **Not returned by `load`** - nothing found is a success
    /// with `found: false` (SPEC section 5). The variant exists so a caller can name the
    /// condition.
    NotFound,
    /// A recognized file exists but cannot be read.
    Unreadable {
        /// The file or directory that could not be read.
        path: PathBuf,
        /// The underlying IO failure.
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    /// A parser rejected the file.
    Malformed {
        /// The file that failed to parse.
        path: PathBuf,
        /// One-based line, when the parser reported one.
        line: Option<usize>,
        /// One-based column, when the parser reported one.
        column: Option<usize>,
        /// The underlying parser failure.
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    /// `config.yaml` beside `config.yml` in one directory (SPEC section 2.5).
    DuplicateFormat {
        /// The directory holding both files.
        path: PathBuf,
    },
    /// A key the caller's type does not declare, under `strict`.
    UnknownKey {
        /// Dotted path of the offending key.
        key_path: String,
    },
    /// A value failed the caller's type.
    Validation {
        /// Dotted path of the offending key, when the deserializer reported one.
        key_path: Option<String>,
        /// What went wrong.
        message: String,
    },
}

impl Error {
    /// The SPEC section 5 kind string.
    ///
    /// The probe serializes this directly rather than matching on variants, so adding a variant
    /// does not mean touching the probe.
    pub fn kind(&self) -> &'static str {
        match self {
            Error::NotFound => "not-found",
            Error::Unreadable { .. } => "unreadable",
            Error::Malformed { .. } => "malformed",
            Error::DuplicateFormat { .. } => "duplicate-format",
            Error::UnknownKey { .. } => "unknown-key",
            Error::Validation { .. } => "validation",
        }
    }

    /// The path this error is about, when it is about one.
    pub fn path(&self) -> Option<&Path> {
        match self {
            Error::Unreadable { path, .. }
            | Error::Malformed { path, .. }
            | Error::DuplicateFormat { path } => Some(path),
            _ => None,
        }
    }

    /// The dotted key path this error is about, when it is about one.
    pub fn key_path(&self) -> Option<&str> {
        match self {
            Error::UnknownKey { key_path } => Some(key_path),
            Error::Validation { key_path, .. } => key_path.as_deref(),
            _ => None,
        }
    }

    pub(crate) fn unreadable(
        path: impl Into<PathBuf>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Error::Unreadable {
            path: path.into(),
            source: Box::new(source),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotFound => write!(f, "not-found: no configuration file at any root"),
            Error::Unreadable { path, source } => {
                write!(f, "unreadable: {}: {source}", path.display())
            }
            Error::Malformed {
                path,
                line,
                column,
                source,
            } => match (line, column) {
                (Some(line), Some(column)) => {
                    write!(f, "malformed: {}:{line}:{column}: {source}", path.display())
                }
                (Some(line), None) => write!(f, "malformed: {}:{line}: {source}", path.display()),
                _ => write!(f, "malformed: {}: {source}", path.display()),
            },
            Error::DuplicateFormat { path } => write!(
                f,
                "duplicate-format: {}: config.yaml and config.yml cannot both be present",
                path.display()
            ),
            Error::UnknownKey { key_path } => write!(f, "unknown-key: {key_path}"),
            Error::Validation { key_path, message } => match key_path {
                Some(key_path) => write!(f, "validation: {key_path}: {message}"),
                None => write!(f, "validation: {message}"),
            },
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Unreadable { source, .. } | Error::Malformed { source, .. } => {
                Some(source.as_ref())
            }
            _ => None,
        }
    }
}

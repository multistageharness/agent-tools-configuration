//! Search-path resolution - SPEC section 2.
//!
//! figment takes explicit paths and never searches, so the upward walk is entirely ours - in
//! every language. This module is the Rust half of keeping those five hand-written walks
//! identical.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use crate::error::Error;

/// A pathological mount or an uncollapsed symlink loop should fail loudly rather than spin. No
/// real tree is 64 directories deep below its repository root.
const MAX_DEPTH: usize = 64;

/// Inputs to the walk that are not the working directory.
#[derive(Debug, Default, Clone)]
pub(crate) struct WalkOptions {
    /// The home directory; the walk stops there, inclusive (SPEC section 2.3).
    pub home: Option<PathBuf>,
    /// An opt-in extra stop condition, inclusive.
    pub stop_dir: Option<PathBuf>,
}

/// Canonicalize, then strip Windows' `\\?\` verbatim prefix.
///
/// Without the strip, every equality comparison in the walk silently fails on Windows:
/// `canonicalize` returns a verbatim path and the values it is compared against do not.
pub(crate) fn canonical(path: &Path) -> Result<PathBuf, Error> {
    let canonical = std::fs::canonicalize(path).map_err(|source| Error::unreadable(path, source))?;
    Ok(strip_verbatim(&canonical))
}

pub(crate) fn strip_verbatim(path: &Path) -> PathBuf {
    let mut components = path.components().peekable();
    if let Some(Component::Prefix(prefix)) = components.peek() {
        if prefix.kind().is_verbatim() {
            let text = path.to_string_lossy();
            if let Some(rest) = text.strip_prefix(r"\\?\") {
                return PathBuf::from(rest);
            }
        }
    }
    path.to_path_buf()
}

/// Every existing `.config/<package_name>/` from `cwd` upward, farthest ancestor first.
///
/// Farthest-first is the SPEC section 2.7 order, so the nearest root is last and therefore wins.
pub(crate) fn resolve_project_roots(
    cwd: &Path,
    package_name: &str,
    opts: &WalkOptions,
) -> Result<Vec<PathBuf>, Error> {
    // SPEC section 2.1: canonicalized exactly once. A failure is reported rather than papered
    // over, because silently walking an uncanonicalized path searches the wrong ancestors.
    let start = canonical(cwd)?;
    let home = opts.home.as_deref().map(canonical_or_clean);
    let stop_dir = opts.stop_dir.as_deref().map(canonical_or_clean);

    let mut roots = Vec::new();
    let mut dir = start;
    for depth in 0.. {
        if depth > MAX_DEPTH {
            return Err(Error::Malformed {
                path: cwd.to_path_buf(),
                line: None,
                column: None,
                source: format!("upward walk exceeded {MAX_DEPTH} directories").into(),
            });
        }

        // SPEC section 2.2: a directory is checked before it is tested for stopping, so a config
        // beside a .git is found and the walk then ends.
        let candidate = dir.join(".config").join(package_name);
        if candidate.is_dir() {
            roots.push(candidate);
        }

        let at_home = home.as_deref() == Some(dir.as_path());
        let at_stop_dir = stop_dir.as_deref() == Some(dir.as_path());
        // Both forms count: a directory in a normal clone, a file in a worktree or a submodule.
        // Those are repositories too.
        let at_repository_boundary = dir.join(".git").exists();
        let parent = dir.parent().map(Path::to_path_buf);

        if at_home || at_stop_dir || at_repository_boundary {
            break;
        }
        match parent {
            Some(parent) if parent != dir => dir = parent,
            _ => break, // Filesystem root.
        }
    }

    roots.reverse();
    Ok(roots)
}

/// Canonicalize when the path exists, and fall back to the path as written otherwise - so a
/// `stop_dir` that has not been created yet still compares by name.
fn canonical_or_clean(path: &Path) -> PathBuf {
    std::fs::canonicalize(path)
        .map(|canonical| strip_verbatim(&canonical))
        .unwrap_or_else(|_| path.to_path_buf())
}

/// The single user-level root of SPEC section 2.4, or `None` when there is none - so a caller
/// can tell "no user config at all" from "the user config directory is empty".
///
/// Windows takes this identical path. `%APPDATA%` and `%LOCALAPPDATA%` are deliberately not
/// consulted (SPEC section 2.4): the same directory has to be readable by five language
/// implementations, and one documented location beats a native one nobody can predict.
///
/// `env` is a [`BTreeMap`] rather than `std::env`, which keeps this hermetic and also makes the
/// warning order deterministic across runs.
pub(crate) fn resolve_user_root(
    package_name: &str,
    home: &Path,
    env: &BTreeMap<String, String>,
    warn: &dyn Fn(&str),
) -> Option<PathBuf> {
    let root = match env.get("XDG_CONFIG_HOME") {
        Some(xdg) if !xdg.is_empty() && Path::new(xdg).is_absolute() => {
            Path::new(xdg).join(package_name)
        }
        Some(xdg) => {
            warn(&format!(
                "ignoring XDG_CONFIG_HOME={xdg:?}: it must be a non-empty absolute path (SPEC section 2.4)"
            ));
            home.join(".config").join(package_name)
        }
        None => home.join(".config").join(package_name),
    };
    root.is_dir().then_some(root)
}

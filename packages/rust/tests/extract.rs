//! `extract` and the error surface.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use config_discovery::{load, Error, Options};
use serde::Deserialize;
use tempfile::TempDir;

fn tree(files: &[(&str, &str)]) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    for (relative, contents) in files {
        let target = dir.path().join(relative);
        if relative.ends_with('/') {
            fs::create_dir_all(&target).expect("mkdir");
            continue;
        }
        fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
        fs::write(&target, contents).expect("write");
    }
    let root = fs::canonicalize(dir.path()).expect("canonicalize");
    (dir, root)
}

fn load_in(root: &Path) -> config_discovery::Loaded {
    load(
        "mytool",
        Options::builder()
            .cwd(root.join("project"))
            .home(root.join("home"))
            .env(BTreeMap::new())
            .on_warning(|_| {})
            .build(),
    )
    .expect("load")
}

#[derive(Debug, Deserialize)]
struct Settings {
    port: u16,
}

// `port` is never read: this type exists to prove that deny_unknown_fields turns an
// unrecognized key into Error::UnknownKey, which happens during deserialization.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictSettings {
    #[allow(dead_code)]
    port: u16,
}

#[test]
fn extract_into_a_struct() {
    let (_guard, root) = tree(&[
        ("project/.git", ""),
        ("project/.config/mytool/config.toml", "port = 5432\nextra = 1\n"),
        ("home/", ""),
    ]);
    let settings: Settings = load_in(&root).extract().unwrap();
    assert_eq!(settings.port, 5432);
}

#[test]
fn deny_unknown_fields_surfaces_unknown_key() {
    let (_guard, root) = tree(&[
        ("project/.git", ""),
        ("project/.config/mytool/config.toml", "port = 5432\nextra = 1\n"),
        ("home/", ""),
    ]);
    let error = load_in(&root).extract::<StrictSettings>().unwrap_err();
    assert_eq!(error.kind(), "unknown-key");
    assert_eq!(error.key_path(), Some("extra"));
}

#[test]
fn a_type_mismatch_surfaces_validation() {
    let (_guard, root) = tree(&[
        ("project/.git", ""),
        ("project/.config/mytool/config.toml", "port = \"not a number\"\n"),
        ("home/", ""),
    ]);
    let error = load_in(&root).extract::<Settings>().unwrap_err();
    assert_eq!(error.kind(), "validation");
}

#[test]
fn kind_covers_every_variant() {
    let cases: Vec<(Error, &str)> = vec![
        (Error::NotFound, "not-found"),
        (
            Error::Unreadable {
                path: PathBuf::from("/x"),
                source: "boom".into(),
            },
            "unreadable",
        ),
        (
            Error::Malformed {
                path: PathBuf::from("/x"),
                line: Some(1),
                column: None,
                source: "boom".into(),
            },
            "malformed",
        ),
        (
            Error::DuplicateFormat {
                path: PathBuf::from("/x"),
            },
            "duplicate-format",
        ),
        (
            Error::UnknownKey {
                key_path: "extra".into(),
            },
            "unknown-key",
        ),
        (
            Error::Validation {
                key_path: None,
                message: "boom".into(),
            },
            "validation",
        ),
    ];
    for (error, kind) in cases {
        assert_eq!(error.kind(), kind);
        assert!(!error.to_string().is_empty());
    }
}

//! End-to-end tests of the public API.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use config_discovery::{load, Options};
use serde_json::json;
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

fn options(root: &Path) -> config_discovery::OptionsBuilder {
    Options::builder()
        .cwd(root.join("project"))
        .home(root.join("home"))
        .env(BTreeMap::new())
        .on_warning(|_| {})
}

#[test]
fn local_only() {
    let (_guard, root) = tree(&[
        ("project/.git", ""),
        ("project/.config/mytool/config.toml", "[log]\nlevel = \"debug\"\n"),
        ("home/", ""),
    ]);
    let loaded = load("mytool", options(&root).build()).unwrap();
    assert_eq!(loaded.config(), &json!({"log": {"level": "debug"}}));
    assert!(loaded.found);
    assert_eq!(loaded.sources.len(), 1);
    assert_eq!(loaded.sources[0].precedence, 2);
}

#[test]
fn user_only() {
    let (_guard, root) = tree(&[
        ("project/.git", ""),
        ("home/.config/mytool/config.toml", "[log]\nlevel = \"info\"\n"),
    ]);
    let loaded = load("mytool", options(&root).build()).unwrap();
    assert_eq!(loaded.sources[0].precedence, 1);
}

#[test]
fn neither_present_is_not_an_error() {
    let (_guard, root) = tree(&[("project/.git", ""), ("home/", "")]);
    let loaded = load("mytool", options(&root).build()).unwrap();
    assert!(!loaded.found);
    assert_eq!(loaded.config(), &json!({}));
    assert!(loaded.sources.is_empty());
    // SPEC section 7 and CANONICAL: an empty list is [], never null.
    assert_eq!(serde_json::to_string(&loaded.sources).unwrap(), "[]");
}

#[test]
fn defaults_survive_but_do_not_set_found() {
    let (_guard, root) = tree(&[("project/.git", ""), ("home/", "")]);
    let defaults = json!({"log": {"level": "warn"}}).as_object().cloned().unwrap();
    let loaded = load("mytool", options(&root).defaults(defaults).build()).unwrap();
    assert_eq!(loaded.config(), &json!({"log": {"level": "warn"}}));
    assert!(!loaded.found);
    assert_eq!(loaded.sources[0].format, "defaults");
}

#[test]
fn three_layers_conflict_and_the_losers_are_still_reported() {
    let (_guard, root) = tree(&[
        ("project/.git", ""),
        ("project/.config/mytool/config.toml", "[log]\nlevel = \"debug\"\n"),
        ("home/.config/mytool/config.toml", "[log]\nlevel = \"info\"\n"),
    ]);
    let env = BTreeMap::from([
        ("MYTOOL_LOG__LEVEL".to_string(), "trace".to_string()),
        ("MYTOOL_PORT".to_string(), "5432".to_string()),
    ]);
    let loaded = load("mytool", options(&root).env(env).build()).unwrap();
    assert_eq!(loaded.config(), &json!({"log": {"level": "trace"}, "port": 5432}));
    let precedences: Vec<u8> = loaded.sources.iter().map(|s| s.precedence).collect();
    assert_eq!(precedences, vec![1, 2, 4]);
}

#[test]
fn overrides_win_over_everything() {
    let (_guard, root) = tree(&[
        ("project/.git", ""),
        ("project/.config/mytool/config.toml", "[log]\nlevel = \"debug\"\n"),
        ("home/", ""),
    ]);
    let env = BTreeMap::from([("MYTOOL_LOG__LEVEL".to_string(), "trace".to_string())]);
    let overrides = json!({"log": {"level": "silent"}}).as_object().cloned().unwrap();
    let loaded = load("mytool", options(&root).env(env).overrides(overrides).build()).unwrap();
    assert_eq!(loaded.config(), &json!({"log": {"level": "silent"}}));
    assert_eq!(loaded.sources.last().unwrap().precedence, 5);
}

#[test]
fn a_package_name_with_a_separator_is_rejected() {
    assert!(load("../evil", Options::default()).is_err());
}

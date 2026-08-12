//! Unit tests for the crate internals.
//!
//! These live inside the crate rather than under `tests/` because everything they exercise is
//! `pub(crate)`: Rust's integration tests see only the public API, and widening the API to make
//! them reachable would be letting the test tail wag the crate. The end-to-end tests that only
//! need the public surface are in `tests/`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tempfile::TempDir;

use crate::discover::{resolve_project_roots, resolve_user_root, strip_verbatim, WalkOptions};
use crate::env::{coerce_value, env_key_path, env_layer};
use crate::loaders::{list_config_files, load_one, strip_json_comments, FileRef};
use crate::merge::{apply_strategy, merge_layers, ArrayMerge, Layer, MergeOptions, Strategy};
use crate::sources::{build_sources, Source};

/// Materialize `[(relative path, contents)]` under a temp directory. A path ending in `/`
/// creates an empty directory.
///
/// Every test builds its own tree and injects `cwd` and `home`. Nothing reads the real working
/// directory or the real home: a suite whose results depend on the machine is not a suite.
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
    // Canonicalized, so comparisons against the walk's output line up on macOS where /var is a
    // symlink to /private/var.
    let root = fs::canonicalize(dir.path()).expect("canonicalize");
    (dir, strip_verbatim(&root))
}

fn no_warnings(_: &str) {}

fn collector() -> (std::rc::Rc<std::cell::RefCell<Vec<String>>>, impl Fn(&str)) {
    let collected = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let sink = collected.clone();
    (collected, move |message: &str| {
        sink.borrow_mut().push(message.to_string())
    })
}

mod discovery {
    use super::*;

    #[test]
    fn finds_a_config_two_levels_up() {
        let (_guard, root) = tree(&[
            (".git", ""),
            (".config/mytool/config.toml", "a = 1\n"),
            ("a/b/", ""),
        ]);
        let roots =
            resolve_project_roots(&root.join("a/b"), "mytool", &WalkOptions::default()).unwrap();
        assert_eq!(roots, vec![root.join(".config/mytool")]);
    }

    #[test]
    fn orders_farthest_ancestor_first() {
        let (_guard, root) = tree(&[
            (".git", ""),
            (".config/mytool/config.toml", "a = 1\n"),
            ("pkg/.config/mytool/config.toml", "a = 2\n"),
            ("pkg/src/", ""),
        ]);
        let roots =
            resolve_project_roots(&root.join("pkg/src"), "mytool", &WalkOptions::default()).unwrap();
        // Order is the contract: the nearest root is last, and last is what wins.
        assert_eq!(
            roots,
            vec![root.join(".config/mytool"), root.join("pkg/.config/mytool")]
        );
    }

    #[test]
    fn a_git_directory_stops_the_walk() {
        let (_guard, root) = tree(&[
            (".config/mytool/config.toml", "a = 1\n"),
            ("repo/.git/HEAD", "ref: refs/heads/main\n"),
            ("repo/pkg/", ""),
        ]);
        let roots =
            resolve_project_roots(&root.join("repo/pkg"), "mytool", &WalkOptions::default())
                .unwrap();
        assert!(roots.is_empty(), "{roots:?}");
    }

    #[test]
    fn a_git_file_also_stops_the_walk() {
        // The form git writes for a linked worktree or a submodule. Those are repositories too,
        // and a walk that only tests for a directory climbs straight past them.
        let (_guard, root) = tree(&[
            (".config/mytool/config.toml", "a = 1\n"),
            ("repo/.git", "gitdir: /elsewhere/.git/worktrees/w\n"),
            ("repo/pkg/", ""),
        ]);
        let roots =
            resolve_project_roots(&root.join("repo/pkg"), "mytool", &WalkOptions::default())
                .unwrap();
        assert!(roots.is_empty(), "{roots:?}");
    }

    #[test]
    fn stop_dir_is_inclusive() {
        let (_guard, root) = tree(&[
            (".git", ""),
            ("pkg/.config/mytool/config.toml", "a = 1\n"),
            ("pkg/src/", ""),
        ]);
        let roots = resolve_project_roots(
            &root.join("pkg/src"),
            "mytool",
            &WalkOptions {
                home: None,
                stop_dir: Some(root.join("pkg")),
            },
        )
        .unwrap();
        assert_eq!(roots, vec![root.join("pkg/.config/mytool")]);
    }

    #[test]
    fn home_is_inclusive() {
        let (_guard, root) = tree(&[
            (".git", ""),
            ("home/.config/mytool/config.toml", "a = 1\n"),
            ("home/work/", ""),
        ]);
        let roots = resolve_project_roots(
            &root.join("home/work"),
            "mytool",
            &WalkOptions {
                home: Some(root.join("home")),
                stop_dir: None,
            },
        )
        .unwrap();
        assert_eq!(roots, vec![root.join("home/.config/mytool")]);
    }

    #[test]
    fn canonicalization_is_what_makes_the_comparison_work() {
        // The comparison path the Windows `\\?\` strip exists for: a home given uncanonicalized
        // must still equal the canonicalized directory the walk is standing in.
        let (_guard, root) = tree(&[("home/.config/mytool/config.toml", "a = 1\n"), ("home/work/", "")]);
        let uncanonical = root.join("home").join(".").join("..").join("home");
        let roots = resolve_project_roots(
            &root.join("home/work"),
            "mytool",
            &WalkOptions {
                home: Some(uncanonical),
                stop_dir: None,
            },
        )
        .unwrap();
        assert_eq!(roots, vec![root.join("home/.config/mytool")]);
    }

    #[test]
    fn the_depth_cap_fires() {
        let dir = tempfile::tempdir().unwrap();
        let mut deep = dir.path().to_path_buf();
        for _ in 0..70 {
            deep.push("d");
        }
        fs::create_dir_all(&deep).unwrap();
        let error = resolve_project_roots(&deep, "mytool", &WalkOptions::default()).unwrap_err();
        assert!(error.to_string().contains("exceeded 64 directories"), "{error}");
    }

    #[test]
    fn user_root_prefers_an_absolute_xdg() {
        let (_guard, root) = tree(&[
            ("xdg/mytool/config.toml", "a = 1\n"),
            ("home/.config/mytool/config.toml", "a = 2\n"),
        ]);
        let env = BTreeMap::from([(
            "XDG_CONFIG_HOME".to_string(),
            root.join("xdg").to_string_lossy().into_owned(),
        )]);
        assert_eq!(
            resolve_user_root("mytool", &root.join("home"), &env, &no_warnings),
            Some(root.join("xdg/mytool"))
        );
    }

    #[test]
    fn user_root_ignores_a_relative_xdg_and_warns() {
        let (_guard, root) = tree(&[("home/.config/mytool/config.toml", "a = 1\n")]);
        let env = BTreeMap::from([("XDG_CONFIG_HOME".to_string(), "../cfg".to_string())]);
        let (collected, warn) = collector();
        let resolved = resolve_user_root("mytool", &root.join("home"), &env, &warn);
        assert_eq!(resolved, Some(root.join("home/.config/mytool")));
        assert_eq!(collected.borrow().len(), 1);
        assert!(collected.borrow()[0].contains("absolute"));
    }

    #[test]
    fn user_root_ignores_an_empty_xdg_and_warns() {
        let (_guard, root) = tree(&[("home/.config/mytool/config.toml", "a = 1\n")]);
        let env = BTreeMap::from([("XDG_CONFIG_HOME".to_string(), String::new())]);
        let (collected, warn) = collector();
        assert!(resolve_user_root("mytool", &root.join("home"), &env, &warn).is_some());
        assert_eq!(collected.borrow().len(), 1);
    }

    #[test]
    fn user_root_falls_back_without_warning() {
        let (_guard, root) = tree(&[("home/.config/mytool/config.toml", "a = 1\n")]);
        let (collected, warn) = collector();
        assert_eq!(
            resolve_user_root("mytool", &root.join("home"), &BTreeMap::new(), &warn),
            Some(root.join("home/.config/mytool"))
        );
        assert!(collected.borrow().is_empty());
    }

    #[test]
    fn user_root_is_none_when_the_directory_is_missing() {
        let (_guard, root) = tree(&[("home/", "")]);
        assert_eq!(
            resolve_user_root("mytool", &root.join("home"), &BTreeMap::new(), &no_warnings),
            None
        );
    }
}

mod loading {
    use super::*;

    const ONE_OF_EVERYTHING: &[(&str, &str)] = &[
        ("c/config.toml", "from_toml = true\nlogLevel = \"debug\"\n"),
        ("c/config.yaml", "from_yaml: true\n"),
        ("c/config.json", "{\"from_json\": true}\n"),
        ("c/config.jsonc", "// a comment\n{\"from_jsonc\": true /* inline */}\n"),
        ("c/config.ini", "[Section]\nport = 5432\nname = local\n"),
        ("c/.env", "FROM__DOTENV=true\nPORT=\"5432\"\n"),
    ];

    fn reference(root: &Path, name: &str, format: &'static str) -> FileRef {
        FileRef {
            path: root.join(name),
            format,
        }
    }

    #[test]
    fn recognized_files_come_back_in_spec_order() {
        let (_guard, root) = tree(ONE_OF_EVERYTHING);
        let names: Vec<_> = list_config_files(&root.join("c"), None)
            .unwrap()
            .into_iter()
            .map(|file| file.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                "config.toml",
                "config.yaml",
                "config.json",
                "config.jsonc",
                "config.ini",
                ".env"
            ]
        );
    }

    #[test]
    fn every_enabled_format_round_trips_with_case_intact() {
        let (_guard, root) = tree(ONE_OF_EVERYTHING);
        let mut merged = Map::new();
        for file in list_config_files(&root.join("c"), None).unwrap() {
            for (key, value) in load_one(&file, "MYTOOL").unwrap() {
                merged.insert(key, value);
            }
        }
        assert_eq!(
            Value::Object(merged),
            json!({
                "from_toml": true,
                // Case survives - the assertion every language in this repo needs.
                "logLevel": "debug",
                "from_yaml": true,
                "from_json": true,
                "from_jsonc": true,
                // INI arrives untyped, so SPEC section 2.5's coercion applies.
                "Section": {"port": 5432, "name": "local"},
                "from": {"dotenv": true},
                // SPEC section 4.6: a value written inside quotes stays a string.
                "port": "5432",
            })
        );
    }

    #[test]
    fn yaml_beside_yml_is_a_duplicate_format_error() {
        let (_guard, root) = tree(&[("c/config.yaml", "a: 1\n"), ("c/config.yml", "a: 2\n")]);
        let error = list_config_files(&root.join("c"), None).unwrap_err();
        assert_eq!(error.kind(), "duplicate-format");
    }

    #[test]
    fn a_profile_file_follows_its_base_file() {
        let (_guard, root) = tree(&[("c/config.toml", "a = 1\n"), ("c/config.prod.toml", "a = 2\n")]);
        let files = list_config_files(&root.join("c"), Some("prod")).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[1].path.ends_with("config.prod.toml"));
    }

    #[test]
    fn malformed_toml_carries_kind_path_and_line() {
        let (_guard, root) = tree(&[("c/config.toml", "[log\nlevel = \n")]);
        let error = load_one(&reference(&root.join("c"), "config.toml", "toml"), "MYTOOL").unwrap_err();
        assert_eq!(error.kind(), "malformed");
        assert_eq!(error.path(), Some(root.join("c/config.toml").as_path()));
        match error {
            crate::Error::Malformed { line, .. } => assert_eq!(line, Some(1)),
            other => panic!("{other}"),
        }
    }

    #[test]
    fn a_read_failure_is_unreadable_not_malformed() {
        // A directory where a file is expected. chmod 000 is not a portable way to express this:
        // an inherited ACL or a privileged user makes it a no-op.
        let (_guard, root) = tree(&[("c/config.toml/", "")]);
        let error = load_one(&reference(&root.join("c"), "config.toml", "toml"), "MYTOOL").unwrap_err();
        assert_eq!(error.kind(), "unreadable");
    }

    #[test]
    fn an_empty_file_is_read_and_empty() {
        let (_guard, root) = tree(&[("c/config.toml", "\n# nothing but a comment\n")]);
        let value = load_one(&reference(&root.join("c"), "config.toml", "toml"), "MYTOOL").unwrap();
        assert!(value.is_empty());
    }

    #[test]
    fn a_format_compiled_out_is_reported_as_disabled() {
        // Every format is on under --all-features, so this asserts the predicate rather than the
        // skip: the skip path itself is exercised by `cargo test --no-default-features`.
        assert!(crate::loaders::format_enabled("toml"));
        assert!(!crate::loaders::format_enabled("nonsense"));
    }

    #[test]
    fn json_comments_are_stripped_only_outside_strings() {
        let stripped = strip_json_comments(r#"{"a": "http://not-a-comment", /* x */ "b": 1} // end"#);
        assert_eq!(stripped, r#"{"a": "http://not-a-comment",  "b": 1} "#);
    }

    #[test]
    fn numeric_parity_across_sources() {
        // A 5432 from a file and a 5432 from an environment variable must be the same value.
        let (_guard, root) = tree(&[
            ("c/config.toml", "port = 5432\n"),
            ("c/config.json", "{\"port\": 5432}\n"),
        ]);
        let from_toml = load_one(&reference(&root.join("c"), "config.toml", "toml"), "MYTOOL").unwrap();
        let from_json = load_one(&reference(&root.join("c"), "config.json", "json"), "MYTOOL").unwrap();
        let from_env = env_layer(
            &BTreeMap::from([("MYTOOL_PORT".to_string(), "5432".to_string())]),
            "MYTOOL",
            &no_warnings,
        );
        assert_eq!(from_toml["port"], from_env["port"]);
        assert_eq!(from_json["port"], from_env["port"]);
        assert_eq!(serde_json::to_string(&from_env).unwrap(), r#"{"port":5432}"#);
    }
}

mod merging {
    use super::*;

    fn layer(value: Value, root: Option<&str>, precedence: u8) -> Layer {
        let (path, format) = match root {
            Some(root) => (format!("{root}/config.toml"), "toml"),
            None => ("<env>".to_string(), "env"),
        };
        Layer {
            value: value.as_object().cloned().unwrap_or_default(),
            source: Source {
                path,
                format: format.to_string(),
                precedence,
                keys: Vec::new(),
            },
            root: root.map(str::to_string),
        }
    }

    fn merge(layers: &[Layer], array_merge: ArrayMerge) -> Value {
        Value::Object(merge_layers(
            layers,
            &MergeOptions {
                array_merge,
                warn: &no_warnings,
            },
        ))
    }

    // These mirror the conformance fixtures one to one, so a unit failure and a conformance
    // failure point at the same clause of SPEC.
    #[test]
    fn both_scalar_conflict() {
        let layers = [
            layer(json!({"log": {"level": "info"}}), Some("/user"), 1),
            layer(json!({"log": {"level": "debug"}}), Some("/project"), 2),
        ];
        assert_eq!(merge(&layers, ArrayMerge::Replace), json!({"log": {"level": "debug"}}));
    }

    #[test]
    fn both_nested_map_merge() {
        let layers = [
            layer(json!({"database": {"host": "db.example.com", "port": 5432}}), Some("/user"), 1),
            layer(json!({"database": {"port": 6543}}), Some("/project"), 2),
        ];
        assert_eq!(
            merge(&layers, ArrayMerge::Replace),
            json!({"database": {"host": "db.example.com", "port": 6543}})
        );
    }

    #[test]
    fn both_array_replace_is_the_default() {
        let layers = [
            layer(json!({"plugins": ["a", "b"]}), Some("/user"), 1),
            layer(json!({"plugins": ["c"]}), Some("/project"), 2),
        ];
        // Asserted against the default directly, so a figment upgrade that changed array
        // behavior could not quietly change this crate's - the merge is ours, and this pins it.
        assert_eq!(merge(&layers, ArrayMerge::Replace), json!({"plugins": ["c"]}));
    }

    #[test]
    fn both_array_concat_keeps_duplicates() {
        let layers = [
            layer(json!({"plugins": ["a", "b"]}), Some("/user"), 1),
            layer(json!({"plugins": ["b", "c"]}), Some("/project"), 2),
        ];
        assert_eq!(
            merge(&layers, ArrayMerge::Concat),
            json!({"plugins": ["a", "b", "b", "c"]})
        );
    }

    #[test]
    fn explicit_null_unsets_while_absent_leaves_alone() {
        let unset = [
            layer(json!({"a": 1}), Some("/user"), 1),
            layer(json!({"a": null}), Some("/project"), 2),
        ];
        assert_eq!(merge(&unset, ArrayMerge::Replace), json!({}));

        let absent = [
            layer(json!({"a": 1}), Some("/user"), 1),
            layer(json!({}), Some("/project"), 2),
        ];
        assert_eq!(merge(&absent, ArrayMerge::Replace), json!({"a": 1}));
    }

    #[test]
    fn a_type_conflict_warns() {
        let (collected, warn) = collector();
        let layers = [
            layer(json!({"log": {"level": "info"}}), Some("/user"), 1),
            layer(json!({"log": "debug"}), Some("/project"), 2),
        ];
        let merged = merge_layers(&layers, &MergeOptions { array_merge: ArrayMerge::Replace, warn: &warn });
        assert_eq!(Value::Object(merged), json!({"log": "debug"}));
        assert_eq!(collected.borrow().len(), 1);
    }

    #[test]
    fn first_match_drops_the_lower_root_from_output_and_sources() {
        let layers = vec![
            layer(json!({"d": 1}), None, 0),
            layer(json!({"log": {"level": "info"}}), Some("/user"), 1),
            layer(json!({"log": {"level": "debug"}}), Some("/project"), 2),
            layer(json!({"log": {"level": "trace"}}), None, 4),
        ];
        let kept = apply_strategy(layers, Strategy::FirstMatch);
        // The user layer is gone entirely - not merged, and not reported.
        assert_eq!(kept.len(), 3);
        assert_eq!(kept[1].root.as_deref(), Some("/project"));
        assert_eq!(
            merge(&kept, ArrayMerge::Replace),
            json!({"d": 1, "log": {"level": "trace"}})
        );
    }

    #[test]
    fn first_match_keeps_every_file_of_the_winning_root() {
        let layers = vec![
            layer(json!({"a": 1}), Some("/user"), 1),
            layer(json!({"a": 2}), Some("/project"), 2),
            Layer {
                value: json!({"a": 3}).as_object().cloned().unwrap(),
                source: Source {
                    path: "/project/.env".into(),
                    format: "dotenv".into(),
                    precedence: 3,
                    keys: Vec::new(),
                },
                root: Some("/project".into()),
            },
        ];
        assert_eq!(apply_strategy(layers, Strategy::FirstMatch).len(), 2);
    }
}

mod environment {
    use super::*;

    #[test]
    fn coercion() {
        assert_eq!(coerce_value("5432", false), json!(5432));
        assert_eq!(coerce_value("true", false), json!(true));
        assert_eq!(coerce_value("[1,2]", false), json!([1, 2]));
        assert_eq!(coerce_value("5432abc", false), json!("5432abc"));
        assert_eq!(coerce_value("1.5", false), json!(1.5));
        assert_eq!(coerce_value("5432", true), json!("5432"));
    }

    #[test]
    fn key_paths_split_on_double_underscore_only() {
        assert_eq!(env_key_path("LOG__LEVEL"), vec!["log", "level"]);
        assert_eq!(env_key_path("SOME_KEY"), vec!["some_key"]);
    }

    #[test]
    fn the_layer_nests_and_ignores_other_prefixes() {
        let env = BTreeMap::from([
            ("MYTOOL_LOG__LEVEL".to_string(), "trace".to_string()),
            ("MYTOOL_SOME_KEY".to_string(), "1".to_string()),
            ("OTHER_THING".to_string(), "x".to_string()),
        ]);
        assert_eq!(
            Value::Object(env_layer(&env, "MYTOOL", &no_warnings)),
            json!({"log": {"level": "trace"}, "some_key": 1})
        );
    }

    #[test]
    fn an_empty_key_path_warns() {
        let (collected, warn) = collector();
        let env = BTreeMap::from([("MYTOOL_".to_string(), "x".to_string())]);
        assert!(env_layer(&env, "MYTOOL", &warn).is_empty());
        assert_eq!(collected.borrow().len(), 1);
    }
}

mod source_list {
    use super::*;

    fn layer(path: &str, value: Value, precedence: u8) -> Layer {
        Layer {
            value: value.as_object().cloned().unwrap_or_default(),
            source: Source {
                path: path.to_string(),
                format: "toml".into(),
                precedence,
                keys: Vec::new(),
            },
            root: None,
        }
    }

    #[test]
    fn keys_are_sorted_and_an_empty_file_is_still_reported() {
        let sources = build_sources(
            &[
                layer("/u/config.toml", json!({"b": 1, "a": 2}), 1),
                layer("/u/.env", json!({}), 3),
            ],
            None,
        );
        assert_eq!(sources[0].keys, vec!["a", "b"]);
        assert!(sources[1].keys.is_empty());
        assert_eq!(serde_json::to_string(&sources[1].keys).unwrap(), "[]");
    }

    #[test]
    fn application_order_is_preserved_rather_than_sorted() {
        // A user-level .env is precedence 3 but belongs inside the user root's block, so it must
        // still be emitted before the project files that outrank it (SPEC section 3.1).
        let sources = build_sources(
            &[
                layer("/u/config.toml", json!({}), 1),
                layer("/u/.env", json!({}), 3),
                layer("/p/config.toml", json!({}), 2),
            ],
            None,
        );
        let order: Vec<u8> = sources.iter().map(|source| source.precedence).collect();
        assert_eq!(order, vec![1, 3, 2]);
    }

    #[test]
    fn relative_to_uses_forward_slashes_and_passes_labels_through() {
        let root = Path::new("/abs/fixture");
        let sources = build_sources(
            &[
                layer("/abs/fixture/project/.config/mytool/config.toml", json!({}), 2),
                layer("<env>", json!({"a": 1}), 4),
            ],
            Some(root),
        );
        assert_eq!(sources[0].path, "project/.config/mytool/config.toml");
        assert_eq!(sources[1].path, "<env>");
    }
}

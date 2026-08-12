//! The cross-language conformance suite, run as part of this crate's own tests.
//!
//! A conformance regression should fail `cargo test`, not only CI.

use std::path::PathBuf;
use std::process::Command;

#[test]
fn every_fixture_passes() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("skipping: the conformance runner needs node");
        return;
    }
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root");

    let output = Command::new("node")
        .arg(repo_root.join("packages/spec/runner/run.mjs"))
        .args(["--probe", "rust"])
        .current_dir(&repo_root)
        .output()
        .expect("run the conformance suite");

    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

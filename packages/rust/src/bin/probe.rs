//! The conformance probe - the adapter between `packages/spec/PROBE.md` and this crate's `load`.
//!
//! Arguments are parsed by hand from `std::env::args`, with no clap: the probe stays free of
//! dependencies the library does not already have.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use config_discovery::{load, ArrayMerge, Options, Strategy};
use serde_json::{json, Map, Value};

/// SPEC section 6. Anything outside this set exits 2 rather than being quietly ignored: a probe
/// that shrugs off `arrayMerge` and still prints a result claims conformance it does not have.
const KNOWN_OPTIONS: &[&str] = &[
    "strategy",
    "arrayMerge",
    "stopDir",
    "envPrefix",
    "profile",
    "strict",
    "defaults",
    "overrides",
];

struct Args {
    package_name: String,
    cwd: PathBuf,
    home: PathBuf,
    fixture_root: PathBuf,
    env: BTreeMap<String, String>,
    options: Map<String, Value>,
}

fn parse_args(argv: Vec<String>) -> Result<Args, String> {
    let mut package_name = None;
    let mut cwd = None;
    let mut home = None;
    let mut fixture_root = None;
    let mut env = BTreeMap::new();
    let mut options = Map::new();

    let mut iter = argv.into_iter();
    while let Some(flag) = iter.next() {
        let mut value = || iter.next().ok_or_else(|| format!("{flag} requires a value"));
        match flag.as_str() {
            "--package-name" => package_name = Some(value()?),
            "--cwd" => cwd = Some(PathBuf::from(value()?)),
            "--home" => home = Some(PathBuf::from(value()?)),
            "--fixture-root" => fixture_root = Some(PathBuf::from(value()?)),
            "--env" => {
                let pair = value()?;
                let (name, item) = pair
                    .split_once('=')
                    .ok_or_else(|| format!("--env expects KEY=VALUE, got {pair:?}"))?;
                env.insert(name.to_string(), item.to_string());
            }
            "--options" => {
                let text = value()?;
                let parsed: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("--options is not valid JSON: {error}"))?;
                options = match parsed {
                    Value::Object(map) => map,
                    _ => return Err("--options must be a JSON object".into()),
                };
            }
            other => return Err(format!("unknown flag {other:?}")),
        }
    }

    Ok(Args {
        package_name: package_name.ok_or("missing required flag --package-name")?,
        cwd: cwd.ok_or("missing required flag --cwd")?,
        home: home.ok_or("missing required flag --home")?,
        fixture_root: fixture_root.ok_or("missing required flag --fixture-root")?,
        env,
        options,
    })
}

fn build_options(args: &Args) -> Result<Options, String> {
    for name in args.options.keys() {
        if !KNOWN_OPTIONS.contains(&name.as_str()) {
            return Err(format!("unsupported option {name:?} (SPEC section 6)"));
        }
    }

    let mut builder = Options::builder()
        .cwd(&args.cwd)
        .home(&args.home)
        // Built only from --env. Never std::env::vars(): this is the line that stops a
        // developer's exported MYTOOL_LOG__LEVEL from silently changing fixture results.
        .env(args.env.clone())
        .relative_to(&args.fixture_root)
        .on_warning(|message| eprintln!("{message}"));

    if let Some(value) = args.options.get("strategy") {
        builder = builder.strategy(match value.as_str() {
            Some("layered") => Strategy::Layered,
            Some("first-match") => Strategy::FirstMatch,
            other => return Err(format!("bad strategy {other:?}")),
        });
    }
    if let Some(value) = args.options.get("arrayMerge") {
        builder = builder.array_merge(match value.as_str() {
            Some("replace") => ArrayMerge::Replace,
            Some("concat") => ArrayMerge::Concat,
            other => return Err(format!("bad arrayMerge {other:?}")),
        });
    }
    if let Some(value) = args.options.get("stopDir").and_then(Value::as_str) {
        builder = builder.stop_dir(value);
    }
    if let Some(value) = args.options.get("envPrefix").and_then(Value::as_str) {
        builder = builder.env_prefix(value);
    }
    if let Some(value) = args.options.get("profile").and_then(Value::as_str) {
        builder = builder.profile(value);
    }
    if let Some(value) = args.options.get("strict").and_then(Value::as_bool) {
        builder = builder.strict(value);
    }
    if let Some(Value::Object(map)) = args.options.get("defaults") {
        builder = builder.defaults(map.clone());
    }
    if let Some(Value::Object(map)) = args.options.get("overrides") {
        builder = builder.overrides(map.clone());
    }
    Ok(builder.build())
}

fn relativize(path: &Path, fixture_root: &Path) -> String {
    match path.strip_prefix(fixture_root) {
        Ok(relative) => relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => path.to_string_lossy().replace('\\', "/"),
    }
}

fn main() -> ExitCode {
    // A panic is this harness breaking, not the library rejecting input: exit 2, so the runner
    // reports the case as unproven rather than as a conformance failure - and never 101.
    std::panic::set_hook(Box::new(|info| {
        eprintln!("probe panicked: {info}");
        std::process::exit(2);
    }));

    let args = match parse_args(std::env::args().skip(1).collect()) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let options = match build_options(&args) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };

    match load(&args.package_name, options) {
        Ok(loaded) => {
            let document = json!({
                "config": loaded.config(),
                "found": loaded.found,
                "sources": loaded.sources,
            });
            print!("{document}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            let mut payload = Map::new();
            payload.insert("kind".into(), Value::String(error.kind().into()));
            payload.insert("message".into(), Value::String(error.to_string()));
            if let Some(path) = error.path() {
                payload.insert(
                    "path".into(),
                    Value::String(relativize(path, &args.fixture_root)),
                );
            }
            if let Some(key_path) = error.key_path() {
                payload.insert("keyPath".into(), Value::String(key_path.into()));
            }
            print!("{}", json!({ "error": payload }));
            ExitCode::from(1)
        }
    }
}

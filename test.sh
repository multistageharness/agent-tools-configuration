#!/bin/sh
# Run every package's tests and report one table.
#
# Same commands CI runs (.github/workflows/conformance.yml), in the same order: the spec harness
# first, then each language package. Each language's own test command already includes its
# conformance run, so a cross-language regression fails here too.
#
#   ./test.sh                 everything that can run on this machine
#   ./test.sh rust go         only those packages
#   ./test.sh --strict        a package that cannot run is a failure, not a skip
#   ./test.sh --list          what would run, and why anything would not
#
# Exit 0 only when nothing failed. A skipped package does not fail the run unless --strict.

set -u
cd "$(dirname "$0")"

# ── output ───────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m')
  GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m'); YELLOW=$(printf '\033[33m')
else
  BOLD=''; DIM=''; RESET=''; GREEN=''; RED=''; YELLOW=''
fi

LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/config-discovery-tests.XXXXXX")
trap 'rm -rf "$LOGDIR"' EXIT INT TERM

PASSED=0
FAILED=0
SKIPPED=0
SUMMARY="$LOGDIR/summary"
: > "$SUMMARY"

# record <status> <name> <detail>
record() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$SUMMARY"
}

# run <name> <directory> <command…> - runs quietly, prints the log only on failure.
run() {
  name=$1
  directory=$2
  shift 2

  printf '%s› %s%s ' "$BOLD" "$name" "$RESET"
  started=$(date +%s)
  log="$LOGDIR/$name.log"

  if (cd "$directory" && "$@") > "$log" 2>&1; then
    elapsed=$(( $(date +%s) - started ))
    printf '%spassed%s %s(%ss)%s\n' "$GREEN" "$RESET" "$DIM" "$elapsed" "$RESET"
    PASSED=$((PASSED + 1))
    record PASS "$name" "${elapsed}s"
  else
    status=$?
    elapsed=$(( $(date +%s) - started ))
    printf '%sFAILED%s %s(exit %s, %ss)%s\n' "$RED" "$RESET" "$DIM" "$status" "$elapsed" "$RESET"
    sed 's/^/    /' "$log"
    printf '\n'
    FAILED=$((FAILED + 1))
    record FAIL "$name" "exit $status"
  fi
}

skip() {
  printf '%s› %s%s %sskipped%s %s- %s%s\n' "$BOLD" "$1" "$RESET" "$YELLOW" "$RESET" "$DIM" "$2" "$RESET"
  SKIPPED=$((SKIPPED + 1))
  record SKIP "$1" "$2"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── what each unit needs, and how to run it ──────────────────────────────────
#
# Each `why_not_<unit>` prints the reason the unit cannot run, or nothing when it can. Keeping
# the reason next to the requirement is what makes a skip actionable instead of mysterious.

why_not_spec() {
  have node || echo "node is not on PATH"
}

why_not_ts() {
  have node || { echo "node is not on PATH"; return; }
  [ -d packages/ts/node_modules ] || echo "dependencies are not installed - run: (cd packages/ts && npm ci)"
}

# Prints the interpreter to use, or nothing when there is none. A function rather than a
# variable because the caller runs `why_not_*` in a command substitution, and an assignment made
# in that subshell would never reach here.
python_interpreter() {
  if [ -x packages/py/.venv/bin/python ]; then
    printf '%s\n' "$PWD/packages/py/.venv/bin/python"
  elif have python3 && (cd packages/py && python3 -c 'import config_discovery, pytest' >/dev/null 2>&1); then
    printf 'python3\n'
  fi
}

why_not_py() {
  have node || { echo "node is not on PATH - the conformance step needs it"; return; }
  [ -n "$(python_interpreter)" ] ||
    echo 'the package is not installed - run: (cd packages/py && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]")'
}

why_not_golang() {
  have node || { echo "node is not on PATH - the conformance step needs it"; return; }
  have go || echo "go is not on PATH"
}

why_not_java() {
  have node || { echo "node is not on PATH - the conformance step needs it"; return; }
  have java || { echo "java is not on PATH"; return; }
  [ -x packages/java/gradlew ] || echo "packages/java/gradlew is missing"
}

why_not_rust() {
  have node || { echo "node is not on PATH - the conformance step needs it"; return; }
  have cargo || echo "cargo is not on PATH"
}

# The spec harness gates everything in CI, and it earns that: five green language jobs produced
# by a runner that cannot detect a failure is worse than a red build. So this checks the runner
# passes its own tests, that the reference probe is green, and - the one that matters - that the
# deliberately broken probe still goes red.
run_spec() {
  run "spec harness" . node --test packages/spec/runner/run.test.mjs
  run "spec reference probe" . node packages/spec/runner/run.mjs \
    --probe-path packages/spec/runner/reference

  printf '%s› %sspec seeded regression%s ' "$BOLD" "$BOLD" "$RESET"
  if node packages/spec/runner/run.mjs --probe-path packages/spec/runner/reference/broken \
      > "$LOGDIR/seeded.log" 2>&1; then
    printf '%sFAILED%s %s- the broken probe passed, so the suite cannot detect a regression%s\n' \
      "$RED" "$RESET" "$DIM" "$RESET"
    sed 's/^/    /' "$LOGDIR/seeded.log"
    FAILED=$((FAILED + 1))
    record FAIL "spec seeded regression" "broken probe passed"
  else
    printf '%spassed%s %s(the broken probe went red, as it must)%s\n' "$GREEN" "$RESET" "$DIM" "$RESET"
    PASSED=$((PASSED + 1))
    record PASS "spec seeded regression" "broken probe went red"
  fi
}

run_ts() { run ts packages/ts npm test; }
run_py() { run py packages/py "$(python_interpreter)" -m pytest; }
run_golang() { run golang packages/golang go test ./...; }
run_java() { run java packages/java ./gradlew --quiet test; }
run_rust() { run rust packages/rust cargo test --all-features; }

# ── arguments ────────────────────────────────────────────────────────────────

UNITS="spec ts py golang java rust"
STRICT=0
LIST=0
SELECTED=""

for argument in "$@"; do
  case $argument in
    --strict) STRICT=1 ;;
    --list) LIST=1 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    go) SELECTED="$SELECTED golang" ;;          # the obvious name for the folder called golang
    typescript|node) SELECTED="$SELECTED ts" ;;
    python) SELECTED="$SELECTED py" ;;
    spec|ts|py|golang|java|rust) SELECTED="$SELECTED $argument" ;;
    -*)
      printf 'unknown option: %s\n' "$argument" >&2
      exit 2
      ;;
    *)
      printf 'unknown package: %s (expected one of: %s)\n' "$argument" "$UNITS" >&2
      exit 2
      ;;
  esac
done
[ -n "$SELECTED" ] && UNITS=$SELECTED

# ── run ──────────────────────────────────────────────────────────────────────

if [ "$LIST" -eq 1 ]; then
  printf '%sunit    would run?%s\n' "$BOLD" "$RESET"
  for unit in $UNITS; do
    reason=$("why_not_$unit")
    if [ -z "$reason" ]; then
      printf '%-7s %syes%s\n' "$unit" "$GREEN" "$RESET"
    else
      printf '%-7s %sno%s  %s%s%s\n' "$unit" "$YELLOW" "$RESET" "$DIM" "$reason" "$RESET"
    fi
  done
  exit 0
fi

printf '%sconfig-discovery%s  %severy package, same commands CI runs%s\n\n' \
  "$BOLD" "$RESET" "$DIM" "$RESET"

for unit in $UNITS; do
  reason=$("why_not_$unit")
  if [ -n "$reason" ]; then
    skip "$unit" "$reason"
    continue
  fi
  "run_$unit"
done

# ── summary ──────────────────────────────────────────────────────────────────

printf '\n%s%-24s %s%s\n' "$BOLD" "unit" "result" "$RESET"
while IFS="$(printf '\t')" read -r status name detail; do
  case $status in
    PASS) colour=$GREEN ;;
    FAIL) colour=$RED ;;
    *)    colour=$YELLOW ;;
  esac
  printf '%-24s %s%-6s%s %s%s%s\n' "$name" "$colour" "$status" "$RESET" "$DIM" "$detail" "$RESET"
done < "$SUMMARY"

printf '\n%s passed, %s failed, %s skipped\n' "$PASSED" "$FAILED" "$SKIPPED"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
if [ "$SKIPPED" -gt 0 ] && [ "$STRICT" -eq 1 ]; then
  printf '%s--strict: a skipped package counts as a failure%s\n' "$YELLOW" "$RESET"
  exit 1
fi
exit 0

#!/usr/bin/env bash
# Test harness for ocean-bot-launch.sh. Each case stands up a synthetic
# git repo, runs the wrapper with overridden REPO/NODE/ENVFILE/LOG, and
# asserts on exit code + log contents. NODE is set to `/usr/bin/true`
# so the final `exec node ...` no-ops in tests.
#
# Run: bash tools/ocean-bot/scripts/ocean-bot-launch.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$SCRIPT_DIR/ocean-bot-launch.sh"

if [ ! -x "$WRAPPER" ]; then
  echo "wrapper not executable: $WRAPPER" >&2
  exit 2
fi

PASS=0
FAIL=0
TMP_ROOT="$(mktemp -d -t ob-launch-test-XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1: $2"; FAIL=$((FAIL + 1)); }

# Build a tiny fake repo with the dirs the wrapper expects. The fake
# package.json's "build" script writes a dist/index.js so the wrapper's
# subsequent "newer src" check sees a populated dist.
setup_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email "t@t"
  git -C "$repo" config user.name "t"
  mkdir -p "$repo/tools/ocean-bot/src"
  cat > "$repo/tools/ocean-bot/package.json" <<'EOF'
{
  "name": "fake-ocean-bot",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "mkdir -p dist && echo // built > dist/index.js"
  }
}
EOF
  echo "// stub" > "$repo/tools/ocean-bot/src/index.ts"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "init"
}

# Run the wrapper with the supplied REPO and capture exit + log.
# Stdout/stderr are merged into the log to keep assertions simple.
run_wrapper() {
  local repo="$1"
  local log="$2"
  : > "$log"
  REPO="$repo" \
    NODE="/usr/bin/true" \
    ENVFILE="/dev/null" \
    LOG="$log" \
    "$WRAPPER" >>"$log" 2>&1
  echo "$?"
}

# ----------------------------------------------------------------------
# Test 1: clean repo on main with fresh dist → exit 0
# ----------------------------------------------------------------------
test_clean_main() {
  local repo="$TMP_ROOT/t1"
  local log="$TMP_ROOT/t1.log"
  setup_repo "$repo"
  # Pre-build so wrapper has nothing to do.
  (cd "$repo/tools/ocean-bot" && npm run build --silent >/dev/null 2>&1)
  local code
  code=$(run_wrapper "$repo" "$log")
  if [ "$code" = "0" ] && grep -q 'launch.ready' "$log"; then
    pass "clean repo on main with fresh dist"
  else
    fail "clean repo on main" "exit=$code, log: $(cat "$log")"
  fi
}

# ----------------------------------------------------------------------
# Test 2: wrong branch checked out → auto-corrected to main, exit 0
# ----------------------------------------------------------------------
test_wrong_branch() {
  local repo="$TMP_ROOT/t2"
  local log="$TMP_ROOT/t2.log"
  setup_repo "$repo"
  git -C "$repo" checkout -q -b feature/wip
  local code
  code=$(run_wrapper "$repo" "$log")
  local final_branch
  final_branch=$(git -C "$repo" symbolic-ref --short HEAD)
  if [ "$code" = "0" ] && [ "$final_branch" = "main" ] && grep -q 'launch.wrong_branch' "$log"; then
    pass "wrong branch auto-corrects to main"
  else
    fail "wrong branch" "exit=$code, final=$final_branch, log: $(cat "$log")"
  fi
}

# ----------------------------------------------------------------------
# Test 3: missing dist → wrapper rebuilds, exit 0
# ----------------------------------------------------------------------
test_missing_dist() {
  local repo="$TMP_ROOT/t3"
  local log="$TMP_ROOT/t3.log"
  setup_repo "$repo"
  # Do not pre-build. dist/ doesn't exist.
  local code
  code=$(run_wrapper "$repo" "$log")
  if [ "$code" = "0" ] && grep -q 'launch.build_needed.*no dist' "$log" \
     && [ -f "$repo/tools/ocean-bot/dist/index.js" ]; then
    pass "missing dist triggers rebuild"
  else
    fail "missing dist" "exit=$code, log: $(cat "$log")"
  fi
}

# ----------------------------------------------------------------------
# Test 4: src newer than dist → wrapper rebuilds, exit 0
# ----------------------------------------------------------------------
test_stale_dist() {
  local repo="$TMP_ROOT/t4"
  local log="$TMP_ROOT/t4.log"
  setup_repo "$repo"
  (cd "$repo/tools/ocean-bot" && npm run build --silent >/dev/null 2>&1)
  # Touch src to make it newer than dist/index.js. macOS find -newer is
  # mtime-based, so a one-second sleep avoids same-second timestamps.
  sleep 1
  touch "$repo/tools/ocean-bot/src/index.ts"
  local code
  code=$(run_wrapper "$repo" "$log")
  if [ "$code" = "0" ] && grep -q 'launch.build_needed.*newer src' "$log"; then
    pass "src newer than dist triggers rebuild"
  else
    fail "stale dist" "exit=$code, log: $(cat "$log")"
  fi
}

# ----------------------------------------------------------------------
# Test 5: build failure → exit 2
# ----------------------------------------------------------------------
test_build_failure() {
  local repo="$TMP_ROOT/t5"
  local log="$TMP_ROOT/t5.log"
  setup_repo "$repo"
  # Overwrite package.json with a failing build script.
  cat > "$repo/tools/ocean-bot/package.json" <<'EOF'
{
  "name": "fake-ocean-bot",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "exit 7"
  }
}
EOF
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "break build"
  local code
  code=$(run_wrapper "$repo" "$log")
  if [ "$code" = "2" ] && grep -q 'launch.build_failed' "$log"; then
    pass "build failure exits 2"
  else
    fail "build failure" "exit=$code, log: $(cat "$log")"
  fi
}

# ----------------------------------------------------------------------
# Test 6: dirty tree → wrapper skips pull but still exec's, exit 0
# ----------------------------------------------------------------------
test_dirty_tree() {
  local repo="$TMP_ROOT/t6"
  local log="$TMP_ROOT/t6.log"
  setup_repo "$repo"
  (cd "$repo/tools/ocean-bot" && npm run build --silent >/dev/null 2>&1)
  echo "dirty" >> "$repo/tools/ocean-bot/src/index.ts"
  local code
  code=$(run_wrapper "$repo" "$log")
  if [ "$code" = "0" ] && grep -q 'launch.dirty_tree' "$log"; then
    pass "dirty tree skips pull, still exec's"
  else
    fail "dirty tree" "exit=$code, log: $(cat "$log")"
  fi
}

# ----------------------------------------------------------------------
# Test 7: repo doesn't exist → exit 2
# ----------------------------------------------------------------------
test_missing_repo() {
  local log="$TMP_ROOT/t7.log"
  local code
  code=$(run_wrapper "$TMP_ROOT/does-not-exist" "$log")
  if [ "$code" = "2" ] && grep -q 'launch.boot_failed' "$log"; then
    pass "missing repo exits 2"
  else
    fail "missing repo" "exit=$code, log: $(cat "$log")"
  fi
}

# ----------------------------------------------------------------------
# Test 8: built-from-sha is written and matches HEAD
# ----------------------------------------------------------------------
test_built_from_sha() {
  local repo="$TMP_ROOT/t8"
  local log="$TMP_ROOT/t8.log"
  setup_repo "$repo"
  local code
  code=$(run_wrapper "$repo" "$log")
  local head
  head=$(git -C "$repo" rev-parse HEAD)
  local stamped
  stamped=$(cat "$repo/tools/ocean-bot/dist/.built-from-sha" 2>/dev/null)
  if [ "$code" = "0" ] && [ -n "$stamped" ] && [ "$stamped" = "$head" ]; then
    pass "built-from-sha matches HEAD after wrapper"
  else
    fail "built-from-sha" "exit=$code head=$head stamped=$stamped"
  fi
}

test_clean_main
test_wrong_branch
test_missing_dist
test_stale_dist
test_build_failure
test_dirty_tree
test_missing_repo
test_built_from_sha

echo
echo "PASS: $PASS, FAIL: $FAIL"
[ "$FAIL" = "0" ]

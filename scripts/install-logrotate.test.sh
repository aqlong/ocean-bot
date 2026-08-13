#!/usr/bin/env bash
# Smoke test for install-logrotate.sh's --rotate path. Runs the script
# against a synthetic log dir and asserts the 7-slot shift + cp+truncate
# semantics hold. Invoked manually or from CI:
#
#   bash tools/ocean-bot/scripts/install-logrotate.test.sh
#
# Exits 0 on success, non-zero with a clear diff on first failure.
#
# Why bash + a real fixture dir (not vitest): the script under test
# is bash + cp + mv + truncate, with semantics that depend on actual
# filesystem behavior (inode preservation, mtime updates). A node-side
# unit test mocking out fs calls would test the harness, not the
# script. The fixture-dir approach exercises the real cp + mv + : >
# code paths.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROTATE_SCRIPT="$SCRIPT_DIR/install-logrotate.sh"

if [ ! -x "$ROTATE_SCRIPT" ] && [ ! -f "$ROTATE_SCRIPT" ]; then
  echo "FAIL: $ROTATE_SCRIPT not found" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d -t ocean-bot-logrotate-test.XXXXXX)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  echo "fixture dir was: $TMP_DIR" >&2
  ls -la "$TMP_DIR" >&2 || true
  trap - EXIT
  exit 1
}

assert_file_contains() {
  local file="$1"
  local expect="$2"
  if [ ! -f "$file" ]; then
    fail "expected file $file to exist"
  fi
  local got
  got="$(cat "$file")"
  if [ "$got" != "$expect" ]; then
    fail "$file: expected '$expect', got '$got'"
  fi
}

assert_file_size() {
  local file="$1"
  local expect_bytes="$2"
  if [ ! -f "$file" ]; then
    fail "expected file $file to exist"
  fi
  local got
  got="$(wc -c < "$file" | tr -d ' ')"
  if [ "$got" != "$expect_bytes" ]; then
    fail "$file: expected size $expect_bytes, got $got"
  fi
}

assert_file_missing() {
  if [ -e "$1" ]; then
    fail "expected $1 to be absent"
  fi
}

# ----- Test 1: first rotation populates .1 and truncates active ------
echo "test 1: first rotation"
echo "first-day-content" > "$TMP_DIR/ocean-bot.log"
echo "first-day-err"     > "$TMP_DIR/ocean-bot.err"
OCEAN_BOT_LOGROTATE_DIR="$TMP_DIR" bash "$ROTATE_SCRIPT" --rotate

assert_file_size     "$TMP_DIR/ocean-bot.log"   0
assert_file_contains "$TMP_DIR/ocean-bot.log.1" "first-day-content"
assert_file_size     "$TMP_DIR/ocean-bot.err"   0
assert_file_contains "$TMP_DIR/ocean-bot.err.1" "first-day-err"
echo "  ok"

# ----- Test 2: second rotation shifts .1 -> .2, new .1 is fresh ------
echo "test 2: second rotation shifts slots"
echo "second-day-content" > "$TMP_DIR/ocean-bot.log"
OCEAN_BOT_LOGROTATE_DIR="$TMP_DIR" bash "$ROTATE_SCRIPT" --rotate

assert_file_size     "$TMP_DIR/ocean-bot.log"   0
assert_file_contains "$TMP_DIR/ocean-bot.log.1" "second-day-content"
assert_file_contains "$TMP_DIR/ocean-bot.log.2" "first-day-content"
echo "  ok"

# ----- Test 3: 7-slot retention; 8th rotation drops the oldest -------
# Clean slate so the test fixture is independent of tests 1+2 leaving
# state behind. 8 rotations through 8 distinct contents: after the
# 8th, slot .1 holds round-8 (most recent), slot .7 holds round-2,
# round-1 is dropped, and .log.8 never exists (KEEP=7 caps the chain).
echo "test 3: 7-slot retention, oldest drops on 8th rotation"
rm -f "$TMP_DIR"/ocean-bot.*
for i in 1 2 3 4 5 6 7 8; do
  echo "round-$i" > "$TMP_DIR/ocean-bot.log"
  OCEAN_BOT_LOGROTATE_DIR="$TMP_DIR" bash "$ROTATE_SCRIPT" --rotate
done
assert_file_contains "$TMP_DIR/ocean-bot.log.1" "round-8"
assert_file_contains "$TMP_DIR/ocean-bot.log.2" "round-7"
assert_file_contains "$TMP_DIR/ocean-bot.log.7" "round-2"
assert_file_missing  "$TMP_DIR/ocean-bot.log.8"
echo "  ok"

# ----- Test 4: cp + truncate preserves the active file's inode ------
# Critical correctness property: the bot's launchd plist opens the
# StandardOutPath FD once at boot and writes via that FD for the
# entire bot lifetime. If rotation mv'd the active file, the FD would
# keep the old inode alive and new writes would never appear in the
# truncated .log slot. Pin inode preservation here.
# Portable inode read. BSD stat (macOS, the production host) spells this
# `-f %i`; GNU coreutils (Linux, CI) spells it `-c %i` and errors on -f
# with "cannot read file system information". The property being tested is
# filesystem semantics, not a platform quirk, so the probe has to work on
# both or this test silently becomes macOS-only.
inode_of() {
  stat -c %i "$1" 2>/dev/null || stat -f %i "$1"
}

echo "test 4: active file inode is preserved across rotation"
echo "before-inode-test" > "$TMP_DIR/ocean-bot.log"
INODE_BEFORE="$(inode_of "$TMP_DIR/ocean-bot.log")"
OCEAN_BOT_LOGROTATE_DIR="$TMP_DIR" bash "$ROTATE_SCRIPT" --rotate
INODE_AFTER="$(inode_of "$TMP_DIR/ocean-bot.log")"
if [ "$INODE_BEFORE" != "$INODE_AFTER" ]; then
  fail "active file inode changed across rotation ($INODE_BEFORE -> $INODE_AFTER); cp+truncate semantics are broken; the bot's open FD would write to the rotated copy"
fi
echo "  ok (inode $INODE_BEFORE preserved)"

# ----- Test 5: rotation on a non-existent log is a no-op, not error -
echo "test 5: missing log file is a no-op"
rm -f "$TMP_DIR"/ocean-bot.*
OCEAN_BOT_LOGROTATE_DIR="$TMP_DIR" bash "$ROTATE_SCRIPT" --rotate
assert_file_missing "$TMP_DIR/ocean-bot.log"
assert_file_missing "$TMP_DIR/ocean-bot.log.1"
echo "  ok"

echo
echo "PASS: all 5 rotation tests"

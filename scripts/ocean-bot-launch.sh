#!/bin/bash
# Ocean-bot boot wrapper. Replaces direct `node dist/index.js` invocation
# in the launchd plist with a sequence that enforces:
#   1. Local repo is on `main`
#   2. Local main is fast-forwarded to origin/main (or stays put if offline)
#   3. dist/ is rebuilt if any src file is newer
#   4. dist/.built-from-sha records the HEAD we built from (for the
#      per-tick drift gate)
# Then exec's node with the sidecar env file (Node 20.6+ --env-file).
#
# Why a wrapper: launchd's ProgramArguments runs ONE process; it cannot
# express "fetch + build + exec" natively. KeepAlive=true in the plist
# auto-restarts the process if it exits, so every restart re-runs this
# wrapper from the top. Stale-dist becomes structurally impossible.
#
# Failure policy:
#   - Network blips on `git fetch` → log warn, proceed with local state
#   - Dirty tree → log warn, skip pull (don't clobber operator WIP)
#   - Divergence (cannot fast-forward) → log error, exit 2 (KeepAlive
#     will restart-loop; ocean-bot.err makes the failure obvious)
#   - Build failure → exit 2 (same restart-loop visibility)
#
# Bash strict mode chosen for safety:
#   -u: unset variables fail (catches typos)
#   -o pipefail: pipe failures propagate
#   NOT -e: we want explicit per-step failure handling, not abort-on-any

set -uo pipefail

REPO="${REPO:-$HOME/code2wiki}"
NODE="${NODE:-/opt/homebrew/bin/node}"
ENVFILE="${ENVFILE:-$HOME/.config/ocean-bot/env}"
LOG="${LOG:-$HOME/Library/Logs/ocean-bot.log}"

# Emit a JSONL line that matches the format the bot writes itself.
log() {
  local level="$1"
  local msg="$2"
  local detail="${3:-}"
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  if [ -n "$detail" ]; then
    printf '{"ts":"%s","level":"%s","msg":"launch.%s","detail":"%s"}\n' \
      "$ts" "$level" "$msg" "$detail" >> "$LOG"
  else
    printf '{"ts":"%s","level":"%s","msg":"launch.%s"}\n' \
      "$ts" "$level" "$msg" >> "$LOG"
  fi
}

if [ ! -d "$REPO/.git" ]; then
  log error "boot_failed" "repo not found at $REPO"
  exit 2
fi

log info "boot_start"

# Step 1: fetch. Soft-fail on network issues.
if ! git -C "$REPO" fetch --quiet origin main 2>/dev/null; then
  log warn "fetch_failed" "proceeding with local state"
fi

# Step 2: ensure we're on main.
CURRENT_BRANCH=$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")
if [ "$CURRENT_BRANCH" != "main" ]; then
  log warn "wrong_branch" "$CURRENT_BRANCH -> main"
  if ! git -C "$REPO" checkout main 2>/dev/null; then
    log error "checkout_failed" "cannot checkout main from $CURRENT_BRANCH"
    exit 2
  fi
fi

# Step 3: fast-forward pull. Skip if tree is dirty (don't clobber operator WIP).
DIRTY=$(git -C "$REPO" status --porcelain 2>/dev/null | head -c 1)
if [ -n "$DIRTY" ]; then
  log warn "dirty_tree" "skipping pull; operator should resolve"
else
  if ! git -C "$REPO" pull --ff-only --quiet origin main 2>/dev/null; then
    # Couldn't fast-forward. Either offline (acceptable) or diverged (bad).
    # --verify -q is critical: without it, `git rev-parse origin/main` on
    # a repo missing origin/main still prints "origin/main" to stdout
    # before the failure, polluting REMOTE_SHA.
    LOCAL_SHA=$(git -C "$REPO" rev-parse HEAD)
    REMOTE_SHA=$(git -C "$REPO" rev-parse --verify -q origin/main 2>/dev/null || echo "unknown")
    if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
      log info "already_synced" "$LOCAL_SHA"
    elif [ "$REMOTE_SHA" = "unknown" ]; then
      log warn "offline" "proceeding with local main"
    else
      log error "diverged" "local=$LOCAL_SHA remote=$REMOTE_SHA"
      exit 2
    fi
  fi
fi

# Step 4: rebuild dist if any src file is newer than dist/index.js.
cd "$REPO/tools/ocean-bot" || { log error "cd_failed" "tools/ocean-bot"; exit 2; }

NEED_BUILD=0
if [ ! -f dist/index.js ]; then
  NEED_BUILD=1
  log info "build_needed" "no dist"
else
  # Find any .ts file in src/ newer than dist/index.js. -newer is mtime-based.
  NEWER=$(find src -name "*.ts" -newer dist/index.js 2>/dev/null | head -n 1)
  if [ -n "$NEWER" ]; then
    NEED_BUILD=1
    log info "build_needed" "newer src: $NEWER"
  fi
fi

if [ "$NEED_BUILD" = "1" ]; then
  log info "build_start"
  if ! npm run build --silent 2>>"$LOG"; then
    log error "build_failed"
    exit 2
  fi
  log info "build_done"
fi

# Step 5: record the SHA we built from, for the per-tick drift gate.
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
echo "$HEAD_SHA" > dist/.built-from-sha
log info "ready" "head=$HEAD_SHA"

# Step 6: exec the bot with the sidecar env. exec replaces this shell, so
# KeepAlive sees the node process directly (not a bash shell wrapping it).
exec "$NODE" --env-file="$ENVFILE" "$REPO/tools/ocean-bot/dist/index.js"

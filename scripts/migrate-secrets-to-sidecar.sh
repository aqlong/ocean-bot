#!/usr/bin/env bash
# One-shot migration: extract OCEAN_BOT_DATABASE_URL (and any other
# secrets) from the legacy launchd plist's EnvironmentVariables dict,
# write them to ~/.config/ocean-bot/env (mode 0600), then re-run the
# installer to produce a plist with NO secrets.
#
# After running this, the plist is safe to share / templatize. The env
# file is operator-private.
#
# Run once after pulling the v2 installer:
#   ./scripts/migrate-secrets-to-sidecar.sh
#
# Idempotent — re-running after migration succeeds is a no-op (the env
# file already has the keys; the new plist already has no secrets).

set -euo pipefail

LABEL="com.craftandship.ocean-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_FILE="$HOME/.config/ocean-bot/env"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$PLIST" ]; then
  echo "no legacy plist at $PLIST — nothing to migrate. Run install-launchd.sh directly after creating $ENV_FILE." >&2
  exit 1
fi

# Use `defaults` (macOS) to read the plist as a structured dict —
# safer than grep. EnvironmentVariables is a dict; defaults will print
# it as a property-list string we can parse.
ENV_DICT="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables" "$PLIST" 2>/dev/null || true)"

if [ -z "$ENV_DICT" ]; then
  echo "no EnvironmentVariables in $PLIST — nothing to migrate. Create $ENV_FILE manually per README." >&2
  exit 1
fi

# Extract every key=value pair from the plist's EnvironmentVariables.
# Filter out the bootstrap keys (PATH, HOME) that should stay in the
# plist; everything else is a secret candidate.
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# PlistBuddy dict output format:
#   Dict {
#       KEY = value
#       KEY2 = value with spaces
#   }
# We strip the wrapper + filter bootstrap keys + write `KEY=value` lines.
MIGRATED=0
while IFS= read -r line; do
  # Match indented "    KEY = value"
  key="$(echo "$line" | sed -nE 's/^[[:space:]]+([A-Z_][A-Z0-9_]*)[[:space:]]*=.*/\1/p')"
  value="$(echo "$line" | sed -nE 's/^[[:space:]]+[A-Z_][A-Z0-9_]*[[:space:]]*=[[:space:]]*(.*)$/\1/p')"
  if [ -z "$key" ]; then continue; fi
  case "$key" in
    PATH|HOME) continue ;;  # bootstrap — stays in plist via installer
  esac
  # Append-or-update in $ENV_FILE (idempotent).
  if grep -q "^${key}=" "$ENV_FILE"; then
    # Replace existing line.
    /usr/bin/sed -i '' -E "s|^${key}=.*$|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  MIGRATED=$((MIGRATED + 1))
  echo "  migrated $key → $ENV_FILE"
done <<EOF
$ENV_DICT
EOF

if [ "$MIGRATED" = "0" ]; then
  echo "nothing to migrate — plist EnvironmentVariables already contains only bootstrap keys (PATH/HOME)."
  if [ -f "$ENV_FILE" ]; then
    echo "✓ env file present at $ENV_FILE (mode $(stat -f '%A' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE"))."
  else
    echo "WARNING: $ENV_FILE missing — bot will fail to boot. Re-create it per tools/ocean-bot/README.md." >&2
    exit 1
  fi
  exit 0
fi

echo ""
echo "migrated $MIGRATED secret(s) to $ENV_FILE (mode 600)."
echo "re-running installer to rewrite plist without secrets…"
"$SCRIPT_DIR/install-launchd.sh"

echo ""
echo "verifying plist no longer contains secrets…"
# Read the actual EnvironmentVariables dict via PlistBuddy (structured)
# instead of grepping the raw XML — grep'ing for "secret" matched the
# installer's HEADER COMMENTS that explain the security rationale, not
# the values. The dict is the only place secrets could survive.
PLIST_ENV="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables" "$PLIST" 2>/dev/null || true)"
LEAKED_KEYS="$(echo "$PLIST_ENV" | sed -nE 's/^[[:space:]]+([A-Z_][A-Z0-9_]*)[[:space:]]*=.*/\1/p' | grep -vE '^(PATH|HOME)$' || true)"
if [ -n "$LEAKED_KEYS" ]; then
  echo "WARNING: plist EnvironmentVariables still contains non-bootstrap keys:" >&2
  echo "$LEAKED_KEYS" >&2
  echo "install-launchd.sh did not rewrite as expected." >&2
  exit 1
else
  echo "✓ plist clean (EnvironmentVariables = only PATH + HOME)."
fi

echo ""
echo "next: rotate the Neon password — the prior value is in this"
echo "session's transcript + the unredacted plist on disk before migration."
echo "  1. https://console.neon.tech → project → Settings → Reset password"
echo "  2. update OCEAN_BOT_DATABASE_URL= in $ENV_FILE with the new URL"
echo "  3. launchctl unload  $PLIST"
echo "  4. launchctl load    $PLIST"
echo "  5. tail -f ~/Library/Logs/ocean-bot.log to verify boot"

#!/usr/bin/env bash
# Install Ocean-bot as a macOS launchd LaunchAgent. Runs at login,
# restarts if it crashes, logs to ~/Library/Logs/ocean-bot.{log,err}.
#
# SECRETS LIVE IN A SIDECAR FILE, NOT IN THE PLIST.
# The plist is safe to share / commit-as-template; the env file lives
# at ~/.config/ocean-bot/env (mode 0600) and is operator-private.
# Node 20.6+ supports `--env-file=PATH` natively; we pass that flag to
# the bot's entrypoint so it reads OCEAN_BOT_DATABASE_URL + any other
# secrets at startup without launchd ever touching them.
#
# Usage:
#   cd tools/ocean-bot
#   npm run build
#   # create the env file once (operator-only; never commit it):
#   mkdir -p ~/.config/ocean-bot && touch ~/.config/ocean-bot/env
#   chmod 600 ~/.config/ocean-bot/env
#   # edit ~/.config/ocean-bot/env to contain:
#   #   OCEAN_BOT_DATABASE_URL=postgresql://...
#   #   (add ANTHROPIC_API_KEY, GITHUB_TOKEN, etc. as the bot grows)
#   ./scripts/install-launchd.sh
#
# Uninstall:
#   launchctl unload ~/Library/LaunchAgents/com.craftandship.ocean-bot.plist
#   rm ~/Library/LaunchAgents/com.craftandship.ocean-bot.plist

set -euo pipefail

LABEL="com.craftandship.ocean-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_ENTRY="$BOT_DIR/dist/index.js"
NODE_BIN="$(command -v node)"
LOG_DIR="$HOME/Library/Logs"
ENV_FILE="$HOME/.config/ocean-bot/env"

if [ ! -f "$DIST_ENTRY" ]; then
  echo "error: $DIST_ENTRY not found. Run 'npm run build' first." >&2
  exit 1
fi

# Env-file presence + permission check. Fail closed if the operator
# hasn't set up the sidecar correctly, we'd rather block install than
# silently launch the bot with no credentials (it would just
# crashloop, but the failure mode is opaque).
if [ ! -f "$ENV_FILE" ]; then
  cat <<EOF >&2
error: env file not found at $ENV_FILE

Create it before re-running this installer:
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # then add at minimum:
  #   OCEAN_BOT_DATABASE_URL=postgresql://...
  # see tools/ocean-bot/README.md for the full slot list.

Never commit this file to git, it holds prod credentials.
EOF
  exit 1
fi

# stat -f for macOS, -c for Linux. macOS first since this script targets launchd.
if command -v stat >/dev/null 2>&1; then
  if stat -f '%A' "$ENV_FILE" >/dev/null 2>&1; then
    MODE="$(stat -f '%A' "$ENV_FILE")"
  else
    MODE="$(stat -c '%a' "$ENV_FILE")"
  fi
  if [ "$MODE" != "600" ]; then
    echo "warning: $ENV_FILE mode is $MODE (expected 600). Tightening." >&2
    chmod 600 "$ENV_FILE"
  fi
fi

mkdir -p "$LOG_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <!-- node --env-file=PATH (Node 20.6+) reads the sidecar env file
       at startup without launchd ever seeing the secret values.
       Plist stays safe to share / template. -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--env-file=$ENV_FILE</string>
    <string>$DIST_ENTRY</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$BOT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/ocean-bot.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/ocean-bot.err</string>
  <!-- EnvironmentVariables holds ONLY non-secret bootstrap (PATH +
       HOME). Anything with credentials goes in $ENV_FILE. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed $LABEL, logs at $LOG_DIR/ocean-bot.{log,err}"
echo "env file: $ENV_FILE (mode 600)"
echo "tail -f $LOG_DIR/ocean-bot.log to watch it run"

# Install the sibling logrotate agent so $LOG_DIR/ocean-bot.{log,err} get
# capped at 7 daily rotations. Idempotent (re-load on every install).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/install-logrotate.sh"

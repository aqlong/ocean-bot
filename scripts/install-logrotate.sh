#!/usr/bin/env bash
# Install or run the ocean-bot log rotation.
#
# The bot's launchd plist writes to ~/Library/Logs/ocean-bot.{log,err} in
# append mode. Without rotation, these grow unbounded (~277 log lines/day
# observed, on the order of GB/year). Eventually the disk fills and the
# bot's writes start failing. This installs a sibling LaunchAgent that
# fires daily at 03:00 local time and keeps 7 rotations:
#
#   ocean-bot.log    , active (truncated to 0 after rotation)
#   ocean-bot.log.1  , yesterday's content
#   ...
#   ocean-bot.log.7  , 7 days ago (oldest kept)
#
# Older content is dropped (overwritten when .6 rotates to .7). Same
# layout applies to ocean-bot.err.
#
# Why cp+truncate (not mv) for the active file: launchd opens
# StandardOutPath with O_APPEND and holds the FD for the duration of
# the bot process. mv would unlink that inode, leaving the renamed
# .log.1 receiving every subsequent write while the .log path is
# absent. cp copies the content to a fresh inode (.log.1) and the
# truncate leaves the FD's inode in place, just emptied. The next
# append from the bot lands at offset 0 of the now-empty file.
#
# Modes:
#   ./install-logrotate.sh           , install + load the rotation plist
#   ./install-logrotate.sh --rotate  , do the rotation (invoked by plist)
#
# Uninstall:
#   launchctl unload ~/Library/LaunchAgents/com.craftandship.ocean-bot.logrotate.plist
#   rm ~/Library/LaunchAgents/com.craftandship.ocean-bot.logrotate.plist

set -euo pipefail

LOG_DIR="${OCEAN_BOT_LOGROTATE_DIR:-$HOME/Library/Logs}"
KEEP=7
LABEL="com.craftandship.ocean-bot.logrotate"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/install-logrotate.sh"

do_rotate() {
  for base in ocean-bot.log ocean-bot.err; do
    local log="$LOG_DIR/$base"
    if [ ! -f "$log" ]; then continue; fi
    # Shift older slots: .6 -> .7 first, then .5 -> .6, ..., .1 -> .2.
    # Reverse order avoids overwriting a slot we still need to read.
    # Older content beyond .7 is dropped (overwritten by .6 -> .7).
    local i
    for i in $(seq $((KEEP - 1)) -1 1); do
      if [ -f "$log.$i" ]; then
        mv "$log.$i" "$log.$((i + 1))"
      fi
    done
    cp "$log" "$log.1"
    : > "$log"
  done
}

do_install() {
  mkdir -p "$HOME/Library/LaunchAgents"
  mkdir -p "$LOG_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT_PATH</string>
    <string>--rotate</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/ocean-bot.logrotate.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/ocean-bot.logrotate.err</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "installed $LABEL: daily 03:00 rotation of $LOG_DIR/ocean-bot.{log,err}"
  echo "rotation log: $LOG_DIR/ocean-bot.logrotate.log"
}

case "${1:-install}" in
  --rotate) do_rotate ;;
  install) do_install ;;
  *) echo "usage: $0 [install|--rotate]" >&2; exit 1 ;;
esac

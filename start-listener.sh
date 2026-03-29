#!/bin/bash
# Persistent launcher for bot.js — auto-restarts on crash
NODE="/opt/homebrew/bin/node"
DIR="$(cd "$(dirname "$0")" && pwd)"
BOT="$DIR/bot.js"
PIDFILE="$DIR/bot.pid"

# Prevent multiple instances
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Already running (PID $OLD_PID). Exiting."
    exit 0
  fi
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

# Always cd into the bot directory so node's process.cwd() works
cd "$DIR"

# Redirect all output to the bot's own log inside Documents (bash has FDA)
exec >> "$DIR/logs/music-bot.log" 2>&1
mkdir -p "$DIR/logs"

while true; do
  $NODE "$BOT"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] bot.js exited, restarting in 10s..."
  sleep 10
done

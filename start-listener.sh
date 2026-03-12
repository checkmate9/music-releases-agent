#!/bin/bash
# Persistent launcher for bot.js — auto-restarts on crash
NODE="/opt/homebrew/bin/node"
DIR="$(cd "$(dirname "$0")" && pwd)"
BOT="$DIR/bot.js"

# Always cd into the bot directory so node's process.cwd() works
cd "$DIR"

while true; do
  $NODE "$BOT"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] bot.js exited, restarting in 10s..."
  sleep 10
done

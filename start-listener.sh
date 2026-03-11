#!/bin/bash
# Persistent launcher for bot.js — auto-restarts on crash
NODE="/opt/homebrew/bin/node"
BOT="$(dirname "$0")/bot.js"

while true; do
  $NODE "$BOT"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] bot.js exited, restarting in 10s..."
  sleep 10
done

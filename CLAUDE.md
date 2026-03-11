# Music Releases Agent — Claude Context

## What This Is
A Node.js agent that fetches new Spotify releases from the past 7 days, filters by genre, and sends a Telegram digest. Zero npm dependencies — uses native Node.js `fetch`.

## Architecture
- `index.js` — main agent: fetch Spotify → filter by genre → send Telegram
- `bot.js` — persistent Telegram listener for `/runnow` manual trigger + built-in scheduler
- `get_refresh_token.js` — one-time OAuth flow to get Spotify refresh token
- `explore_genres.js` — interactive tool to discover genre tags on Spotify
- `genres.json` — editable list of preferred genre keywords (takes precedence over GENRES env)
- `seen_releases.json` — auto-managed deduplication file (gitignored)

## How It Runs
Triggered every 6h by the master LaunchAgent at `~/Library/LaunchAgents/com.agents.every6h.plist`.
The LaunchAgent calls `~/Documents/claude-code/run-agents-every-6h.sh` which runs both agents in parallel.

Manual trigger:
```bash
node index.js         # one-shot run
node bot.js           # persistent listener (enables /runnow from Telegram)
```

## Required .env
```
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REFRESH_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
GENRES=jazz,electronic,indie  # fallback if genres.json missing
```

## Genre Filtering
`genres.json` is a JSON array of keyword strings. Partial, case-insensitive match against Spotify artist genres.
Example: `["jazz", "electronic", "indie", "hip-hop"]`

## Logs
- `agent.log` — run output (gitignored)
- `bot.log` — Telegram listener activity (gitignored)
- `seen_releases.json` — processed release IDs (gitignored)

## Key Flows
1. Spotify OAuth refresh → get fresh access token
2. Fetch `/browse/new-releases?limit=50`
3. Batch-fetch artist genres via `/artists?ids=...`
4. Filter: past 7 days + genre match + not in seen_releases.json
5. Send Telegram digest
6. Update seen_releases.json

## Migration to New Machine
1. Clone repo: `git clone https://github.com/checkmate9/music-releases-agent.git`
2. Copy `.env` with secrets (from secrets backup)
3. Copy `seen_releases.json` (from secrets backup, to avoid re-sending old releases)
4. Set up LaunchAgent from `claude-code-scheduler` repo

## Troubleshooting
| Problem | Fix |
|---|---|
| Spotify 401 | Re-run `node get_refresh_token.js` |
| Telegram 400 | Check BOT_TOKEN and CHAT_ID in .env |
| No releases | Broaden genres in genres.json |
| Port 8888 busy | `lsof -ti:8888 \| xargs kill` |

# Music Releases Agent

A daily digest agent that fetches new Spotify releases filtered by genre and sends them to a Telegram chat.

## Requirements

- Node.js 18+ (uses native `fetch`, no extra dependencies)
- A Spotify developer app
- A Telegram bot

---

## One-time setup

### 1. Clone / copy the project files

```
music-releases-agent/
├── index.js               ← main agent
├── get_refresh_token.js   ← OAuth helper (run once)
├── .env.example           ← copy to .env and fill in
├── seen_releases.json     ← auto-managed, starts as []
└── README.md
```

### 2. Create a Spotify app

1. Go to <https://developer.spotify.com/dashboard> and log in.
2. Click **Create App**.
3. Set any name/description.
4. Under **Redirect URIs**, add exactly: `http://localhost:8888/callback`
5. Save. Copy the **Client ID** and **Client Secret**.

### 3. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/newbot` and follow the prompts.
3. Copy the **bot token** it gives you (format: `123456:ABC-DEF...`).
4. Start a conversation with your new bot (send it any message).
5. Find your **chat ID**:
   - Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   - Look for `"chat":{"id": 123456789}` in the response.

### 4. Configure .env

```bash
cp .env.example .env
```

Open `.env` and fill in:

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
GENRES=jazz,electronic,indie
```

Leave `SPOTIFY_REFRESH_TOKEN` blank for now — next step gets it.

### 5. Get your Spotify refresh token (one-time)

```bash
node get_refresh_token.js
```

- It prints an authorization URL — open it in your browser.
- Authorize the app.
- The terminal prints your `SPOTIFY_REFRESH_TOKEN`.
- Paste it into `.env`.

### 6. Test the agent

```bash
node index.js
```

You should see log output and receive a Telegram message if matching releases are found.

---

## Genre filtering

The `GENRES` env var is a comma-separated list of keyword strings.

A release is **included** when:
- It was released in the past 7 days, AND
- At least one of its artists has a Spotify genre that **contains** one of your keywords (partial, case-insensitive match).

Examples:
| Keyword | Matches |
|---------|---------|
| `electronic` | electro-pop, electronic, electronica, electroclash |
| `jazz` | jazz, acid jazz, jazz fusion, nu jazz |
| `indie` | indie pop, indie rock, indie folk |
| `hip-hop` | hip-hop, hip hop, trap, boom bap |

---

## Running daily with cron

Open your crontab:

```bash
crontab -e
```

Add a line to run every day at 08:00 AM local time:

```cron
0 8 * * * /usr/local/bin/node /path/to/music-releases-agent/index.js >> /path/to/music-releases-agent/agent.log 2>&1
```

Replace `/path/to/music-releases-agent` with the absolute path to the project folder.

Find your Node path with:

```bash
which node
```

### macOS LaunchAgent alternative

Create `~/Library/LaunchAgents/com.music-releases-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.music-releases-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/music-releases-agent/index.js</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/path/to/music-releases-agent/agent.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/music-releases-agent/agent.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.music-releases-agent.plist
```

---

## How it works

1. **Refresh Spotify token** — access tokens expire in 1 hour; the agent always fetches a fresh one using your stored refresh token.
2. **Fetch `/browse/new-releases?limit=50`** — Spotify's new-releases endpoint returns up to 50 recent albums/singles.
3. **Batch-fetch artist genres** — collects all artist IDs from the results and calls `/artists?ids=...` (up to 50 per request) to get genre tags.
4. **Filter** — keeps only releases from the past 7 days whose artists match your genre keywords. Already-seen IDs (stored in `seen_releases.json`) are skipped.
5. **Send Telegram digest** — formats matched releases into a readable message and posts it via the Bot API.
6. **Update seen_releases.json** — marks new IDs as seen so they never appear again.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing env vars` | Check your `.env` file has all required fields |
| `Spotify token refresh failed 401` | Your refresh token may be invalid — re-run `get_refresh_token.js` |
| `Telegram sendMessage failed 400` | Check your `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` |
| No releases found | Try broader genres, or check Spotify's new-releases in your region |
| Port 8888 in use | Kill the process: `lsof -ti:8888 \| xargs kill` |

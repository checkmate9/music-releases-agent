#!/usr/bin/env node
/**
 * get_refresh_token.js
 *
 * One-time script to obtain a Spotify refresh token via OAuth 2.0 Authorization Code flow.
 * Uses a manual "paste the redirect URL" approach — no local HTTPS server needed.
 *
 * Usage:
 *   node get_refresh_token.js
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Load .env
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = 'https://localhost';

const SCOPES = ['user-read-private', 'user-read-email'].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build authorization URL
// ---------------------------------------------------------------------------
const authParams = new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  scope: SCOPES,
  redirect_uri: REDIRECT_URI,
});

const authUrl = `https://accounts.spotify.com/authorize?${authParams}`;

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Spotify Refresh Token Helper');
console.log('══════════════════════════════════════════════════════════════\n');
console.log('1. Open this URL in your browser:\n');
console.log(`   ${authUrl}\n`);
console.log('2. Log in and click "Agree" to authorize the app.');
console.log('3. Your browser will redirect to https://localhost/?code=...');
console.log('   The page will show an error (that\'s fine — no server is running there).');
console.log('4. Copy the FULL URL from your browser\'s address bar and paste it below.\n');

// ---------------------------------------------------------------------------
// Exchange code for tokens
// ---------------------------------------------------------------------------
async function exchangeCode(code) {
  console.log('\n  Exchanging code for tokens…');
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`);
  }

  const tokens = await tokenRes.json();
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  ✅  Success! Add this to your .env file:');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`SPOTIFY_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  return tokens.refresh_token;
}

// ---------------------------------------------------------------------------
// Non-interactive mode: node get_refresh_token.js <redirect-url>
// Interactive mode: prompts for the redirect URL
// ---------------------------------------------------------------------------
const cliArg = process.argv[2];

if (cliArg) {
  // CLI mode — URL passed as argument
  let code;
  try {
    const parsed = new URL(cliArg.trim());
    code = parsed.searchParams.get('code');
    const error = parsed.searchParams.get('error');
    if (error) throw new Error(`Spotify returned error: ${error}`);
  } catch (err) {
    console.error('\n❌  Could not parse URL:', err.message);
    process.exit(1);
  }
  if (!code) {
    console.error('\n❌  No "code" parameter found in the URL.');
    process.exit(1);
  }
  exchangeCode(code).catch((err) => { console.error('❌', err.message); process.exit(1); });
} else {
  // Interactive mode — prompt user
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Paste the full redirect URL here: ', async (input) => {
    rl.close();
    let code;
    try {
      const parsed = new URL(input.trim());
      code = parsed.searchParams.get('code');
      const error = parsed.searchParams.get('error');
      if (error) throw new Error(`Spotify returned error: ${error}`);
    } catch (err) {
      console.error('\n❌  Could not parse URL:', err.message);
      process.exit(1);
    }
    if (!code) {
      console.error('\n❌  No "code" parameter found in the URL. Make sure you copied the full address bar URL.');
      process.exit(1);
    }
    exchangeCode(code).catch((err) => { console.error('❌', err.message); process.exit(1); });
  });
}

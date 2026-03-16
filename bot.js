#!/usr/bin/env node
/**
 * bot.js — Telegram command listener
 * Runs persistently, polls for /runnow and triggers index.js
 * Start: node bot.js   (kept alive by LaunchAgent)
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌  TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env');
  process.exit(1);
}

// Authorised chat IDs (the owner + any channels the bot is admin of)
const ALLOWED_CHATS = new Set(
  TELEGRAM_CHAT_ID.split(',').map(s => s.trim())
);

let offset = 0;
let agentRunning = false;

// ---------------------------------------------------------------------------
// Built-in scheduler (00:00, 06:00, 12:00, 18:00 IST)
// Replaces cron — runs inside the bot process, handles laptop sleep gracefully
// ---------------------------------------------------------------------------
const SCHEDULE_HOURS = [0, 6, 12, 18];
const GRACE_MINUTES  = 5;   // fire if within 5 min of scheduled time (handles wake-from-sleep)
let lastScheduledHour = -1; // prevents double-fire within same hour window

function istHourMinute() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  return { hour: ist.getHours(), minute: ist.getMinutes() };
}

async function schedulerTick() {
  const { hour, minute } = istHourMinute();
  if (!SCHEDULE_HOURS.includes(hour)) { lastScheduledHour = -1; return; }
  if (minute >= GRACE_MINUTES || lastScheduledHour === hour) return;

  lastScheduledHour = hour;
  console.log(`⏰  Scheduled run at ${String(hour).padStart(2, '0')}:00 IST`);

  if (agentRunning) { console.log('  Skipped — agent already running.'); return; }

  agentRunning = true;
  const { err, stdout } = await runAgent();
  agentRunning = false;

  if (err) {
    console.error('Scheduled agent error:', err.message);
    await sendMessage(TELEGRAM_CHAT_ID, `❌ Scheduled run (${String(hour).padStart(2,'0')}:00) failed:\n<code>${err.message.slice(0, 300)}</code>`);
  } else {
    const lines  = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    const recent  = (lines.find(l => l.includes('Recent (past'))  || '').match(/:\s*(\d+)/)?.[1] ?? '?';
    const matched = (lines.find(l => l.includes('Genre-matched')) || '').match(/:\s*(\d+)/)?.[1] ?? '?';
    const sent    = lines.some(l => l.includes('✅') && l.includes('Sent'));

    const summary = stdout.split('\n')
      .filter(l => l.trim() && (l.includes('Genre-matched') || l.includes('Sent') || l.includes('No new') || l.includes('Recent')))
      .join(' | ');
    console.log(`  Done: ${summary || 'no output'}`);

    // Always notify on Telegram so you know the run happened
    if (!sent) {
      const otherGenresLine = lines.find(l => l.includes('Other genres seen:')) || '';
      const otherGenres = otherGenresLine.replace(/.*Other genres seen:\s*/, '').trim();
      let msg = `🔍 Checked at ${String(hour).padStart(2,'0')}:00 IST — ${recent} new releases, ${matched} matched your genres. Nothing to send.`;
      if (otherGenres) msg += `\n\n💡 <i>Other genres found: ${otherGenres}</i>`;
      await sendMessage(TELEGRAM_CHAT_ID, msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------
async function getUpdates() {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=25`,
      { signal: AbortSignal.timeout(30000) }
    );
    if (!res.ok) return [];
    return (await res.json()).result || [];
  } catch { return []; }
}

async function sendMessage(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error('sendMessage failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Run the agent as a child process
// Use /bin/bash (which has Full Disk Access) to spawn node so it can
// read files inside ~/Documents without permission errors.
// ---------------------------------------------------------------------------
function runAgent() {
  const indexPath = path.join(__dirname, 'index.js');
  const nodeCmd   = `/opt/homebrew/bin/node ${indexPath}`;
  return new Promise(resolve => {
    execFile('/bin/bash', ['-c', nodeCmd], { cwd: __dirname },
      (err, stdout, stderr) => resolve({ err, stdout: stdout + stderr })
    );
  });
}

// ---------------------------------------------------------------------------
// Long-poll loop
// ---------------------------------------------------------------------------
async function poll() {
  console.log('🤖  Bot listener started. Send /runnow to trigger the agent.');

  while (true) {
    const updates = await getUpdates();

    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message || update.channel_post;
      if (!msg) continue;

      const text    = (msg.text || '').trim();
      const chatId  = String(msg.chat.id);
      const chatStr = msg.chat.username ? `@${msg.chat.username}` : chatId;

      // Only respond to authorised chats
      if (!ALLOWED_CHATS.has(chatId) && !ALLOWED_CHATS.has(chatStr)) continue;

      if (text === '/runnow' || text.startsWith('/runnow@')) {
        if (agentRunning) {
          await sendMessage(chatId, '⏳ Agent is already running, please wait…');
          continue;
        }

        console.log(`/runnow from ${chatId}`);
        await sendMessage(chatId, '⏳ Running music agent now…');
        agentRunning = true;

        const { err, stdout } = await runAgent();
        agentRunning = false;

        if (err) {
          console.error('Agent error:', err.message);
          await sendMessage(chatId, `❌ Agent failed:\n<code>${err.message.slice(0, 300)}</code>`);
        } else {
          const sent = stdout.includes('✅') && stdout.includes('Sent');
          if (!sent) {
            const matchLine    = stdout.split('\n').find(l => l.includes('Genre-matched')) || '';
            const otherLine    = stdout.split('\n').find(l => l.includes('Other genres seen:')) || '';
            const otherGenres  = otherLine.replace(/.*Other genres seen:\s*/, '').trim();
            let msg = `🔍 Done — ${matchLine.trim() || 'No new matching releases.'}`;
            if (otherGenres) msg += `\n\n💡 <i>Other genres found: ${otherGenres}</i>`;
            await sendMessage(chatId, msg);
          }
          // If digest was sent, index.js already posted to Telegram — no second message needed
        }
      }
    }

    // Small pause between polls to avoid hammering on empty responses
    if (updates.length === 0) await new Promise(r => setTimeout(r, 1000));
  }
}

// Start scheduler — check every 60 seconds; also check immediately on startup
schedulerTick();
setInterval(schedulerTick, 60 * 1000);

poll().catch(err => { console.error('Fatal:', err); process.exit(1); });

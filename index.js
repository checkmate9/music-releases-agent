#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌  .env file not found. Copy .env.example and fill in your credentials.');
    process.exit(1);
  }
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

const {
  SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET,
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  GENRES = 'jazz,electronic,indie',
} = process.env;

// genres.json takes precedence over GENRES env var — edit it any time
const GENRES_FILE = path.join(__dirname, 'genres.json');
let GENRE_LIST;
if (fs.existsSync(GENRES_FILE)) {
  try { GENRE_LIST = JSON.parse(fs.readFileSync(GENRES_FILE, 'utf8')).map(g => g.trim().toLowerCase()); }
  catch { console.warn('⚠️  genres.json invalid, using GENRES env var'); }
}
if (!GENRE_LIST) GENRE_LIST = GENRES.split(',').map(g => g.trim().toLowerCase());

const SEEN_PATH    = path.join(__dirname, 'seen_releases.json');
const PENDING_PATH = path.join(__dirname, 'pending_spotify.json');

// ---------------------------------------------------------------------------
// Seen store
// ---------------------------------------------------------------------------
function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeen(set) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...set], null, 2));
}

// ---------------------------------------------------------------------------
// Pending Spotify store — releases sent without a Spotify link
// ---------------------------------------------------------------------------
function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); }
  catch { return []; }
}
function savePending(list) {
  fs.writeFileSync(PENDING_PATH, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------------------
// Spotify — Client Credentials (for search only; browse endpoints blocked in dev mode)
// ---------------------------------------------------------------------------
async function getSpotifyToken() {
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Spotify token failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// Search Apple Music (iTunes API, free, no auth) — returns url or null
async function searchAppleMusic(title, artist) {
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&entity=album&limit=5`);
    if (!res.ok) return null;
    const items = (await res.json()).results || [];
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wantTitle  = norm(title);
    const wantArtist = norm(artist);
    for (const item of items) {
      if (norm(item.collectionName) === wantTitle && norm(item.artistName).includes(wantArtist))
        return item.collectionViewUrl;
    }
    // Fuzzy fallback
    if (items[0]) return items[0].collectionViewUrl;
    return null;
  } catch { return null; }
}

// YouTube Music search URL — always works as last-resort fallback
function youtubeMusicUrl(title, artist) {
  return `https://music.youtube.com/search?q=${encodeURIComponent(`${artist} ${title}`)}`;
}

// Search Spotify for an album — returns { url } or null
async function searchSpotifyAlbum(title, artist, token) {
  const q = encodeURIComponent(`album:${title} artist:${artist}`);
  try {
    const res = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=album&limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const items = (await res.json()).albums?.items || [];
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wantTitle  = norm(title);
    const wantArtist = norm(artist);
    // Exact match first
    for (const item of items) {
      if (norm(item.name) === wantTitle && item.artists.some(a => norm(a.name) === wantArtist))
        return item.external_urls.spotify;
    }
    // Fuzzy: title contains
    for (const item of items) {
      if (norm(item.name).includes(wantTitle) || wantTitle.includes(norm(item.name)))
        return item.external_urls.spotify;
    }
    return null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// MusicBrainz genre lookup — free public API, rate-limited to 1 req/sec
// ---------------------------------------------------------------------------
const mbCache  = {};
let mbLastCall = 0;

async function mbSleep() {
  const wait = 1100 - (Date.now() - mbLastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  mbLastCall = Date.now();
}

async function lookupMusicBrainzGenres(artistName) {
  if (mbCache[artistName] !== undefined) return mbCache[artistName];
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mbSleep();
      const searchRes = await fetch(
        `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(artistName)}&limit=1&fmt=json`,
        { headers: { 'User-Agent': 'music-releases-agent/1.0 (local-tool)' }, signal: AbortSignal.timeout(10000) }
      );
      if (searchRes.status === 503 || searchRes.status === 429) throw new Error(`MB rate limit ${searchRes.status}`);
      if (!searchRes.ok) throw new Error(`MB search ${searchRes.status}`);
      const artist = (await searchRes.json()).artists?.[0];
      if (!artist) { mbCache[artistName] = []; return []; }

      await mbSleep();
      const artistRes = await fetch(
        `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=tags&fmt=json`,
        { headers: { 'User-Agent': 'music-releases-agent/1.0 (local-tool)' }, signal: AbortSignal.timeout(10000) }
      );
      if (!artistRes.ok) throw new Error(`MB artist ${artistRes.status}`);
      const tags = ((await artistRes.json()).tags || [])
        .sort((a, b) => b.count - a.count).slice(0, 10).map(t => t.name.toLowerCase());
      console.log(`    MB [${artistName}]: ${tags.join(', ') || 'no tags'}`);
      mbCache[artistName] = tags;
      return tags;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const wait = 3000 * attempt;
        console.warn(`    ⚠️  MusicBrainz attempt ${attempt} failed for "${artistName}" (${err.message}), retrying in ${wait/1000}s…`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.warn(`    ⚠️  MusicBrainz failed for "${artistName}" after ${MAX_RETRIES} attempts: ${err.message}`);
        mbCache[artistName] = [];
        return [];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Genre helpers
// ---------------------------------------------------------------------------
function matchesGenres(genres) {
  const lower = genres.map(g => g.toLowerCase());
  return GENRE_LIST.some(want => lower.some(have => have.includes(want)));
}
function bestMatch(genres) {
  const lower = genres.map(g => g.toLowerCase());
  return GENRE_LIST.find(want => lower.some(have => have.includes(want))) || null;
}

// ---------------------------------------------------------------------------
// Pitchfork — RSS feed + individual page for score
// ---------------------------------------------------------------------------
const PF_RSS = 'https://pitchfork.com/feed/feed-album-reviews/rss';
const PF_UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function titleToSlug(title) {
  return title.toLowerCase().replace(/[''""]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function slugToTitle(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function artistFromSlug(urlSlug, albumTitle) {
  const albumSlug = titleToSlug(albumTitle);
  // Remove album slug from end of URL slug to isolate artist slug
  const idx = urlSlug.lastIndexOf(albumSlug);
  if (idx > 0) return slugToTitle(urlSlug.slice(0, idx).replace(/-$/, ''));
  // Fallback: take first word(s) before album words
  return slugToTitle(urlSlug.split('-')[0]);
}

async function fetchPitchforkScore(pfUrl) {
  try {
    const res = await fetch(pfUrl, { headers: { 'User-Agent': PF_UA } });
    if (!res.ok) return { score: null, bnm: false };
    const html = await res.text();
    const scoreM = html.match(/"score"\s*:\s*([0-9.]+)/);
    const bnm    = /best-new-music|isBestNew/.test(html);
    return { score: scoreM ? scoreM[1] : null, bnm };
  } catch { return { score: null, bnm: false }; }
}

async function fetchPitchforkReleases() {
  try {
    const res = await fetch(PF_RSS, { headers: { 'User-Agent': PF_UA } });
    if (!res.ok) { console.warn(`  ⚠️  Pitchfork RSS ${res.status}`); return []; }
    const xml   = await res.text();
    const items = [];
    for (const item of xml.split(/<item>/i).slice(1)) {
      const titleM = item.match(/<title>(.*?)<\/title>/s);
      const linkM  = item.match(/<link>(https:\/\/pitchfork\.com\/reviews\/albums\/([^</"]+))\/?<\/link>/s);
      const dateM  = item.match(/<pubDate>(.*?)<\/pubDate>/);
      if (!titleM || !linkM) continue;
      const albumTitle = titleM[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const urlSlug    = linkM[2].trim();
      const pfUrl      = linkM[1].trim();
      const artist     = artistFromSlug(urlSlug, albumTitle);
      const date       = dateM ? new Date(dateM[1]).toISOString().slice(0, 10) : '';
      items.push({ title: albumTitle, artist, date, slug: `pf:${urlSlug}`, pfUrl, source: 'pitchfork' });
    }
    return items;
  } catch (err) {
    console.warn('  ⚠️  Pitchfork fetch failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Metacritic scraper
// ---------------------------------------------------------------------------
function parseMetacriticHtml(html) {
  const releases = [];
  for (const block of html.split(/<tr[\s>]/i).slice(1)) {
    const titleM  = block.match(/class="title"[^>]*>\s*<h3>([^<]+)<\/h3>/i);
    const artistM = block.match(/class="artist"[^>]*>\s*by\s+([^\n<]+)/i);
    const dateM   = block.match(/class="artist"[\s\S]*?<span[^>]*>((?:January|February|March|April|May|June|July|August|September|October|November|December)[^<]+)<\/span>/i);
    const scoreM  = block.match(/class="metascore_w[^"]*"[^>]*>\s*(\d+)\s*<\/div>/i);
    const linkM   = block.match(/href="(\/music\/[^"#?]+)"/i);
    if (!titleM || !linkM) continue;
    releases.push({
      title:  titleM[1].trim(),
      artist: artistM?.[1].trim() || '',
      date:   dateM?.[1].trim()   || '',
      score:  scoreM?.[1]         || null,
      slug:   linkM[1],
      mcUrl:  'https://www.metacritic.com' + linkM[1],
    });
  }
  return releases;
}

const MC_URLS = [
  'https://www.metacritic.com/browse/albums/release-date/new-releases/date',
  'https://www.metacritic.com/browse/albums/release-date/available/date',
];

async function fetchMetacriticReleases() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const pages = await Promise.all(MC_URLS.map(async url => {
    const res = await fetch(url, { headers });
    if (!res.ok) { console.warn(`  ⚠️  Metacritic fetch failed for ${url}: ${res.status}`); return []; }
    return parseMetacriticHtml(await res.text());
  }));

  // Merge and deduplicate by slug — new-releases page takes priority (listed first)
  const seen = new Set();
  const merged = [];
  for (const page of pages) {
    for (const r of page) {
      if (!seen.has(r.slug)) { seen.add(r.slug); merged.push(r); }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function fmtDate(str) {
  if (!str) return '';
  try {
    if (/^\d{4}$/.test(str)) return str;
    return new Date(str + (str.length === 7 ? '-01' : ''))
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return str; }
}
function todayLabel() {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const time = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time} IST`;
}

// ---------------------------------------------------------------------------
// Telegram (chunked to stay under 4096-char limit)
// ---------------------------------------------------------------------------
async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram failed: ${res.status} ${await res.text()}`);
}

async function sendChunked(header, lines) {
  const LIMIT = 4000;
  let chunk = header;
  for (const line of lines) {
    if ((chunk + '\n\n' + line).length > LIMIT) {
      await sendTelegram(chunk);
      chunk = line;
    } else {
      chunk += '\n\n' + line;
    }
  }
  if (chunk.trim()) await sendTelegram(chunk);
}

// ---------------------------------------------------------------------------
// Build a single release line
// ---------------------------------------------------------------------------
function buildLine(r) {
  const genreTag = r.matchedGenre ? ` [${r.matchedGenre}]` : '';
  const bnmTag   = r.bnm          ? ' 🌟BNM'               : '';
  const score    = r.score        ? ` ⭐<b>${r.score}</b>` : '';
  const dateStr  = r.date         ? ` · ${fmtDate(r.date)}` : '';
  const streamBtn = r.spotifyUrl
    ? `<a href="${r.spotifyUrl}">🎧 Spotify</a>`
    : `<a href="${r.fallbackUrl}">🎧 ${r.fallbackName}</a>`;
  const reviewUrl   = r.source === 'pitchfork' ? r.pfUrl : r.mcUrl;
  const reviewLabel = r.source === 'pitchfork' ? '📰 Pitchfork' : '📰 Metacritic';
  const reviewBtn   = `<a href="${reviewUrl}">${reviewLabel}</a>`;
  return `<b>${r.artist}</b> — <i>${r.title}</i>${genreTag}${bnmTag}${score}${dateStr}\n${streamBtn}  ${reviewBtn}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('🎵  Music Releases Agent starting…');

  const missing = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']
    .filter(k => !process.env[k]);
  if (missing.length) { console.error(`❌  Missing env vars: ${missing.join(', ')}`); process.exit(1); }

  console.log(`  Genres filter: ${GENRE_LIST.join(', ')}`);

  const seen   = loadSeen();
  const cutoff = daysAgo(7);

  // 1. Fetch all sources in parallel
  const [token, mcRaw, pfRaw] = await Promise.all([
    getSpotifyToken(),
    fetchMetacriticReleases().catch(err => { console.warn('  ⚠️  Metacritic failed:', err.message); return []; }),
    fetchPitchforkReleases().catch(err => { console.warn('  ⚠️  Pitchfork failed:', err.message); return []; }),
  ]);
  console.log(`  Spotify token OK`);
  console.log(`  Metacritic: ${mcRaw.length} releases | Pitchfork: ${pfRaw.length} releases`);

  // 2. Merge sources — Metacritic takes priority; deduplicate by normalised artist+title
  const normStr  = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const crossKey = r => `ak:${normStr(r.artist)}-${normStr(r.title)}`;
  const seenKeys = new Set(mcRaw.map(crossKey));
  const pfOnly   = pfRaw.filter(r => !seenKeys.has(crossKey(r)));
  const allRaw   = [...mcRaw, ...pfOnly];

  // 3. Filter by date and seen (check both slug AND normalised artist+title key)
  const recent = allRaw.filter(r => {
    if (seen.has(r.slug) || seen.has(crossKey(r))) return false;
    if (!r.date) return true;
    const d = new Date(r.date);
    return !isNaN(d) && d >= cutoff;
  });
  console.log(`  Recent (past 7 days, not seen): ${recent.length} (MC: ${recent.filter(r=>!r.source).length} PF: ${recent.filter(r=>r.source==='pitchfork').length})`);

  // 4. Resolve genres via MusicBrainz and filter
  const matched = [];
  const seenGenreCount = {};
  for (const r of recent) {
    // Split on commas only — "&" is often part of the artist name (e.g. "Iron & Wine")
    const artists = r.artist ? r.artist.split(',').map(s => s.trim()).filter(Boolean) : [];
    let allGenres = [];
    for (const name of artists) {
      const g = await lookupMusicBrainzGenres(name);
      allGenres.push(...g);
    }
    if (!matchesGenres(allGenres)) {
      // Collect genres from unmatched releases so we can suggest them
      for (const g of allGenres) seenGenreCount[g] = (seenGenreCount[g] || 0) + 1;
      continue;
    }
    matched.push({ ...r, matchedGenre: bestMatch(allGenres), spotifyUrl: null, bnm: false });
  }
  console.log(`  Genre-matched: ${matched.length}`);

  // Print top unmatched genres so bot.js can surface them as suggestions
  const topUnmatched = Object.entries(seenGenreCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([g]) => g);
  if (topUnmatched.length > 0) {
    console.log(`  Other genres seen: ${topUnmatched.join(', ')}`);
  }

  // 4b. Fetch Pitchfork score + BNM flag for matched Pitchfork releases
  for (const r of matched.filter(r => r.source === 'pitchfork')) {
    const { score, bnm } = await fetchPitchforkScore(r.pfUrl);
    r.score = score;
    r.bnm   = bnm;
    if (bnm) console.log(`    ⭐ BNM: ${r.artist} — ${r.title}`);
  }

  if (matched.length === 0) {
    console.log('  No new matching releases. Nothing to send.');
    return;
  }

  // 4. Search Spotify (then Apple Music fallback) for each matched release
  console.log('  Looking up streaming links…');
  for (const r of matched) {
    r.spotifyUrl   = await searchSpotifyAlbum(r.title, r.artist, token);
    r.fallbackUrl  = null;
    r.fallbackName = null;
    if (!r.spotifyUrl) {
      const am = await searchAppleMusic(r.title, r.artist);
      if (am) {
        r.fallbackUrl  = am;
        r.fallbackName = 'Apple Music';
      } else {
        r.fallbackUrl  = youtubeMusicUrl(r.title, r.artist);
        r.fallbackName = 'YouTube Music';
      }
    }
    const label = r.spotifyUrl ? '✅ Spotify' : `🔀 ${r.fallbackName}`;
    console.log(`    ${r.artist} — ${r.title}: ${label}`);
  }

  // 5. Build and send message
  const mcSourceUrl = 'https://www.metacritic.com/browse/albums/release-date/new-releases/date';
  const pfSourceUrl = 'https://pitchfork.com/reviews/albums/';
  const header = `🎵 <b>New Music — ${todayLabel()}</b>\n<a href="${mcSourceUrl}">📋 Metacritic</a>  <a href="${pfSourceUrl}">📋 Pitchfork</a>\n<i>Genres: ${GENRE_LIST.join(', ')}</i>`;
  const lines  = matched.map(buildLine);
  const footer = `\n<i>Total: ${matched.length} new release${matched.length !== 1 ? 's' : ''} across your genres</i>`;
  lines.push(footer);

  console.log('  Sending Telegram digest…');
  await sendChunked(header, lines);
  console.log('  ✅  Sent!');

  // 6. Mark ALL matched releases as seen immediately (prevents duplicate sends).
  //    Releases sent without a Spotify link go into pending_spotify.json for follow-up.
  const pending = loadPending();
  for (const r of matched) {
    seen.add(r.slug);
    seen.add(crossKey(r));
    if (!r.spotifyUrl) {
      pending.push({ slug: r.slug, crossKey: crossKey(r), artist: r.artist, title: r.title });
    }
  }
  saveSeen(seen);
  savePending(pending);
  console.log(`  Seen store: ${seen.size} slugs | Pending Spotify: ${pending.length}`);

  // 7. Retry pending releases — check if Spotify link is now available and send a brief update
  if (pending.length > 0) {
    console.log('  Checking pending releases for Spotify links…');
    const stillPending = [];
    for (const p of pending) {
      if (matched.some(r => r.slug === p.slug)) { stillPending.push(p); continue; } // just sent, skip
      const url = await searchSpotifyAlbum(p.title, p.artist, token);
      if (url) {
        console.log(`    🎧 Spotify now available: ${p.artist} — ${p.title}`);
        await sendTelegram(`🎧 Now on Spotify: <b>${p.artist}</b> — <i>${p.title}</i>\n<a href="${url}">Open on Spotify</a>`);
      } else {
        stillPending.push(p);
      }
    }
    savePending(stillPending);
    if (stillPending.length !== pending.length)
      console.log(`  Pending Spotify resolved: ${pending.length - stillPending.length}, remaining: ${stillPending.length}`);
  }

  console.log('Done.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

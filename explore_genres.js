#!/usr/bin/env node
/**
 * explore_genres.js — Genre explorer
 *
 * Fetches recent Metacritic releases, looks up MusicBrainz tags for every artist,
 * then prints a ranked list of genres with the albums that belong to each.
 *
 * Usage:
 *   node explore_genres.js          # last 30 days (default)
 *   node explore_genres.js 60       # last 60 days
 *   node explore_genres.js 14 20    # last 14 days, top 20 genres
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
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

const DAYS    = parseInt(process.argv[2] || '30', 10);
const TOP_N   = parseInt(process.argv[3] || '40', 10);

// ---------------------------------------------------------------------------
// Metacritic scraper (same as index.js)
// ---------------------------------------------------------------------------
const MC_URLS = [
  'https://www.metacritic.com/browse/albums/release-date/new-releases/date',
  'https://www.metacritic.com/browse/albums/release-date/available/date',
];

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
    });
  }
  return releases;
}

async function fetchMetacriticReleases() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const pages = await Promise.all(MC_URLS.map(async url => {
    const res = await fetch(url, { headers });
    if (!res.ok) { console.warn(`  ⚠️  Metacritic ${url}: ${res.status}`); return []; }
    return parseMetacriticHtml(await res.text());
  }));
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
// MusicBrainz (same rate-limiting as index.js)
// ---------------------------------------------------------------------------
const mbCache  = {};
let mbLastCall = 0;

async function mbSleep() {
  const wait = 1100 - (Date.now() - mbLastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  mbLastCall = Date.now();
}

async function lookupMBGenres(artistName) {
  if (mbCache[artistName] !== undefined) return mbCache[artistName];
  try {
    await mbSleep();
    const searchRes = await fetch(
      `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(artistName)}&limit=1&fmt=json`,
      { headers: { 'User-Agent': 'music-releases-agent/1.0 (local-tool)' } }
    );
    if (!searchRes.ok) throw new Error(`MB search ${searchRes.status}`);
    const artist = (await searchRes.json()).artists?.[0];
    if (!artist) { mbCache[artistName] = []; return []; }

    await mbSleep();
    const artistRes = await fetch(
      `https://musicbrainz.org/ws/2/artist/${artist.id}?inc=tags&fmt=json`,
      { headers: { 'User-Agent': 'music-releases-agent/1.0 (local-tool)' } }
    );
    if (!artistRes.ok) throw new Error(`MB artist ${artistRes.status}`);
    const tags = ((await artistRes.json()).tags || [])
      .sort((a, b) => b.count - a.count).slice(0, 15).map(t => t.name.toLowerCase());
    mbCache[artistName] = tags;
    return tags;
  } catch {
    mbCache[artistName] = [];
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);

  console.log(`\n🔍  Fetching Metacritic releases from the last ${DAYS} days…\n`);
  const all = await fetchMetacriticReleases();

  const recent = all.filter(r => {
    if (!r.date) return true;
    const d = new Date(r.date);
    return !isNaN(d) && d >= cutoff;
  });
  console.log(`Found ${recent.length} releases in range (${all.length} total on page)\n`);
  console.log(`Looking up MusicBrainz genres — this takes ~${Math.ceil(recent.length * 2.5)}s due to rate limiting…\n`);

  // Genre → [{artist, title, score}]
  const genreMap = {};
  const noTags   = [];

  for (let i = 0; i < recent.length; i++) {
    const r = recent[i];
    process.stdout.write(`  [${i + 1}/${recent.length}] ${r.artist} — ${r.title} … `);

    const artistNames = r.artist.split(',').map(s => s.trim()).filter(Boolean);
    let allTags = [];
    for (const name of artistNames) {
      const tags = await lookupMBGenres(name);
      allTags.push(...tags);
    }
    // Deduplicate tags for this release
    allTags = [...new Set(allTags)];

    if (allTags.length === 0) {
      process.stdout.write('no tags\n');
      noTags.push(r);
    } else {
      process.stdout.write(`${allTags.slice(0, 5).join(', ')}\n`);
      for (const tag of allTags) {
        if (!genreMap[tag]) genreMap[tag] = [];
        genreMap[tag].push(r);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Output ranked genre list
  // ---------------------------------------------------------------------------
  const ranked = Object.entries(genreMap)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, TOP_N);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`🎸  TOP ${TOP_N} GENRES across ${recent.length} recent releases (last ${DAYS} days)`);
  console.log(`${'─'.repeat(70)}\n`);

  for (const [genre, releases] of ranked) {
    const albumList = releases
      .map(r => `${r.artist} — ${r.title}${r.score ? ` [${r.score}]` : ''}`)
      .join('\n       ');
    console.log(`  ${String(releases.length).padStart(2)} releases  •  "${genre}"`);
    console.log(`       ${albumList}\n`);
  }

  if (noTags.length > 0) {
    console.log(`${'─'.repeat(70)}`);
    console.log(`⚠️   ${noTags.length} releases had NO MusicBrainz tags (skipped by genre filter):`);
    for (const r of noTags) {
      console.log(`     • ${r.artist} — ${r.title}${r.score ? ` [${r.score}]` : ''}`);
    }
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`💡  To update your genre filter, edit: genres.json`);
  console.log(`    Current genres.json:`);
  try {
    const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'genres.json'), 'utf8'));
    console.log(`    ${JSON.stringify(g)}`);
  } catch { console.log('    (not found)'); }
  console.log(`${'─'.repeat(70)}\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

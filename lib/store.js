'use strict';

/**
 * Server-side persistence (zero dependencies).
 * - data/progress.json  : watch progress keyed by media key, with titles.
 * - data/watchlist.json : user's personal watchlist.
 * Atomic writes; loaded once at boot, kept in memory.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('[store] mkdir failed:', e.message);
  }
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error('[store] read failed for', file, e.message);
  }
  return fallback;
}

let writes = 0;
function writeJsonAtomic(file, value) {
  ensureDataDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
  writes++;
}

// ------------------------------------------------------------- progress ----

let progress = readJson(PROGRESS_FILE, {});
let watchlist = readJson(WATCHLIST_FILE, []);

function mediaKey(mediaType, tmdbId, season, episode) {
  const base = mediaType + ':' + tmdbId;
  return mediaType === 'tv' && season != null && episode != null
    ? base + ':' + season + ':' + episode
    : base;
}

function setProgress(mediaType, tmdbId, season, episode, seconds, duration, title, poster) {
  const key = mediaKey(mediaType, tmdbId, season, episode);
  const rec = {
    key,
    mediaType,
    tmdbId: Number(tmdbId),
    season: mediaType === 'tv' ? Number(season) : null,
    episode: mediaType === 'tv' ? Number(episode) : null,
    seconds: Math.floor(seconds || 0),
    duration: Math.floor(duration || 0),
    pct: duration ? Math.min(100, Math.round((seconds / duration) * 100)) : null,
    title: title || null,
    poster: poster || null,
    updatedAt: Date.now()
  };
  progress[key] = rec;
  try {
    writeJsonAtomic(PROGRESS_FILE, progress);
  } catch (e) {
    console.error('[store] progress write failed:', e.message);
  }
  return rec;
}

function getProgress(mediaType, tmdbId, season, episode) {
  return progress[mediaKey(mediaType, tmdbId, season, episode)] || null;
}

/** Resume point for the NEXT unwatched episode of a show (null if none). */
function nextUpForShow(mediaType, tmdbId) {
  if (mediaType !== 'tv') {
    const rec = progress[mediaKey('movie', tmdbId)];
    return (rec && rec.pct < 95) ? { season: null, episode: null, seconds: rec.seconds } : null;
  }
  const eps = Object.values(progress)
    .filter(r => r.mediaType === 'tv' && r.tmdbId === Number(tmdbId))
    .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
  if (!eps.length) return null;
  const last = eps[eps.length - 1];
  const finished = last.duration && (last.seconds / last.duration) > 0.95;
  return {
    season: finished ? last.season : last.season,
    episode: finished ? last.episode + 1 : last.episode,
    seconds: finished ? 0 : last.seconds
  };
}

function listProgress(limit) {
  return Object.values(progress)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit || 60);
}

function deleteProgress(mediaType, tmdbId, season, episode) {
  const key = mediaKey(mediaType, tmdbId, season, episode);
  const existed = !!progress[key];
  delete progress[key];
  if (existed) {
    try { writeJsonAtomic(PROGRESS_FILE, progress); } catch (e) { /* noop */ }
  }
  return existed;
}

// ------------------------------------------------------------ watchlist ----

function watchlistHas(mediaType, tmdbId) {
  return watchlist.some(w => w.mediaType === mediaType && w.tmdbId === Number(tmdbId));
}

function watchlistAdd(item) {
  if (watchlistHas(item.mediaType, item.tmdbId)) return false;
  watchlist.unshift({
    mediaType: item.mediaType,
    tmdbId: Number(item.tmdbId),
    title: item.title || 'Unknown',
    poster: item.poster || null,
    year: item.year || null,
    rating: item.rating || null,
    addedAt: Date.now()
  });
  try { writeJsonAtomic(WATCHLIST_FILE, watchlist); } catch (e) { /* noop */ }
  return true;
}

function watchlistRemove(mediaType, tmdbId) {
  const before = watchlist.length;
  watchlist = watchlist.filter(w => !(w.mediaType === mediaType && w.tmdbId === Number(tmdbId)));
  if (watchlist.length !== before) {
    try { writeJsonAtomic(WATCHLIST_FILE, watchlist); } catch (e) { /* noop */ }
  }
  return watchlist.length !== before;
}

function listWatchlist() {
  return watchlist;
}

// ------------------------------------------------------------ episodes ----

/** All watched episode records for one show, for checkmarks in the season UI. */
function watchedEpisodesForShow(tmdbId) {
  return Object.values(progress)
    .filter(r => r.mediaType === 'tv' && r.tmdbId === Number(tmdbId))
    .map(r => ({ season: r.season, episode: r.episode, pct: r.pct, seconds: r.seconds, duration: r.duration }));
}

module.exports = {
  setProgress, getProgress, nextUpForShow, listProgress, deleteProgress,
  watchlistHas, watchlistAdd, watchlistRemove, listWatchlist,
  watchedEpisodesForShow
};

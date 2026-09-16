'use strict';

/**
 * VidAPI / VaPlayer integration layer (zero dependencies).
 * - Embed URL builder honoring the documented parameters
 *   (primaryColor, title, poster, showTitle, autoplay, startAt, resumeAt,
 *    sub_url, sub_label, sub_lang, sub_default, controls, overlay, thumbnails).
 * - Catalog endpoints: /movies/latest/page-N.json, /tvshows/latest/...,
 *   /episodes/latest/..., /imdb/api/?action=stats and downloadable ID lists.
 * - Base URL and API key configurable via env: VIDAPI_BASE, VIDAPI_KEY.
 */

const VIDAPI_BASE = (process.env.VIDAPI_BASE || 'https://vaplayer.ru').replace(/\/+$/, '');
const VIDAPI_KEY = process.env.VIDAPI_KEY || '';

// Raw hex — buildEmbedUrl() sets params via URLSearchParams, which encodes it exactly once.
const JARVIS_COLOR = process.env.PRIMARY_COLOR || '#ff7b1f';

// ---------------------------------------------------------------- cache ----

const cache = new Map();
function cacheGet(key, ttl) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value) {
  if (cache.size > 600) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- fetch ----

async function vidapiFetch(pathname) {
  const url = VIDAPI_BASE + pathname;
  const headers = { accept: 'application/json' };
  if (VIDAPI_KEY) headers['x-api-key'] = VIDAPI_KEY;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    const err = new Error('VidAPI unreachable: ' + e.message);
    err.upstreamDown = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('VidAPI ' + res.status + ' for ' + pathname);
    err.status = res.status;
    err.upstreamDown = res.status >= 500 || res.status === 401 || res.status === 403;
    throw err;
  }
  return res.json();
}

async function catalog(pathAndPage) {
  const key = 'cat:' + pathAndPage;
  const hit = cacheGet(key, 6 * 60 * 60 * 1000); // 6h cache for catalog pages
  if (hit) return hit;
  const value = await vidapiFetch(pathAndPage);
  return cacheSet(key, value);
}

// ------------------------------------------------------- embed builder ----

/**
 * Build a VaPlayer embed URL.
 * opts: { imdbId, tmdbId, mediaType, season, episode, color, title, poster,
 *         showTitle, autoplay, startAt, resumeAt, subUrl, subLabel, subLang,
 *         subDefault, controls, overlay, thumbnails }
 */
function buildEmbedUrl(opts) {
  const imdb = opts.imdbId || null;
  const tmdb = opts.tmdbId || null;
  if (!imdb && !tmdb) throw new Error('buildEmbedUrl requires imdbId or tmdbId');

  const q = new URLSearchParams();

  // Player customization
  if (opts.color !== undefined) q.set('color', opts.color);
  if (opts.color !== undefined) q.set('primaryColor', opts.color);
  if (opts.title) q.set('title', opts.title);
  if (opts.poster) q.set('poster', opts.poster);
  if (opts.showTitle !== undefined) q.set('showTitle', String(!!opts.showTitle));
  if (opts.autoplay !== undefined) q.set('autoplay', opts.autoplay ? '1' : '0');
  if (Number.isFinite(opts.startAt)) q.set('startAt', String(Math.floor(opts.startAt)));
  if (Number.isFinite(opts.resumeAt)) q.set('resumeAt', String(Math.floor(opts.resumeAt)));
  if (opts.subUrl) {
    q.set('sub_url', opts.subUrl);
    if (opts.subLabel) q.set('sub_label', opts.subLabel);
    if (opts.subLang) q.set('sub_lang', opts.subLang);
    if (opts.subDefault !== undefined) q.set('sub_default', String(!!opts.subDefault));
  }
  if (opts.controls !== undefined) q.set('controls', String(!!opts.controls));
  if (opts.overlay !== undefined) q.set('overlay', String(!!opts.overlay));
  if (opts.thumbnails) q.set('thumbnails', opts.thumbnails);
  // Best-effort quality hint for players that honor it; ignored otherwise
  // (most players auto-select the highest available bitrate by default).
  if (opts.quality) {
    q.set('quality', opts.quality);
    q.set('maxQuality', opts.quality);
  }
  if (VIDAPI_KEY) q.set('api_key', VIDAPI_KEY);

  const qs = q.toString();
  const isTv = (opts.mediaType || 'movie') === 'tv';

  if (isTv) {
    const s = opts.season || 1;
    const e = opts.episode || 1;
    const idPart = imdb || tmdb;
    const path = '/embed/tv/' + idPart + '/' + s + '/' + e;
    return VIDAPI_BASE + path + (qs ? '?' + qs : '');
  }

  const path = imdb ? '/embed/movie/' + imdb : '/embed/movie/' + tmdb;
  return VIDAPI_BASE + path + (qs ? '?' + qs : '');
}

/** Parse "tt0944947_1x1" style catalog episode ids. */
function parseCatalogEpisodeId(id) {
  const m = /^(tt\d+|[0-9]+)_(\d+)x(\d+)$/.exec(String(id || ''));
  if (!m) return null;
  return { id: m[1], season: Number(m[2]), episode: Number(m[3]) };
}

// ------------------------------------------------------------ listings ----

/** Normalize the VidAPI latest-lists payload into a UI-friendly shape. */
function normalizeCatalogItem(raw) {
  const imdb = raw.imdb_id || raw.imdbId || raw.imdb || null;
  const tmdb = raw.tmdb_id || raw.tmdbId || raw.tmdb || null;
  const mediaType = raw.media_type || raw.mediaType ||
    (raw.season !== undefined || raw.episode !== undefined ? 'episode' : (raw.type || 'movie'));
  return {
    catalogId: raw.id || raw.catalog_id || null,
    imdbId: imdb,
    tmdbId: tmdb && String(tmdb),
    mediaType,
    title: raw.title || raw.name || raw.show_title || 'Unknown',
    year: raw.year || null,
    poster: raw.poster || raw.poster_path || null,
    rating: raw.rating || raw.vote_average || null,
    genres: raw.genres || raw.genre || null,
    popularity: raw.popularity || null,
    season: raw.season ?? null,
    episode: raw.episode ?? null,
    airDate: raw.air_date || raw.airDate || null,
    embedUrl: raw.embed_url || raw.embedUrl || null
  };
}

async function latestMovies(page) {
  const data = await catalog('/movies/latest/page-' + page + '.json');
  const items = (data.items || []).map(normalizeCatalogItem);
  return { page: data.page || page, perPage: data.per_page || 24, total: data.total || 0, totalPages: data.total_pages || 0, items };
}

async function latestTv(page) {
  const data = await catalog('/tvshows/latest/page-' + page + '.json');
  const items = (data.items || []).map(normalizeCatalogItem);
  return { page: data.page || page, perPage: data.per_page || 24, total: data.total || 0, totalPages: data.total_pages || 0, items };
}

async function latestEpisodes(page) {
  const data = await catalog('/episodes/latest/page-' + page + '.json');
  const items = (data.items || []).map(normalizeCatalogItem);
  return { page: data.page || page, perPage: data.per_page || 24, total: data.total || 0, totalPages: data.total_pages || 0, items };
}

async function stats() {
  return catalog('/imdb/api/?action=stats');
}

// ------------------------------------------------------------ id lists ----

const ID_LISTS = {
  'movie_list_imdb.txt': '/ids/movie_list_imdb.txt',
  'movie_list_tmdb.txt': '/ids/movie_list_tmdb.txt',
  'tv_list_imdb.txt': '/ids/tv_list_imdb.txt',
  'tv_list_tmdb.txt': '/ids/tv_list_tmdb.txt',
  'eps_list_imdb.txt': '/ids/eps_list_imdb.txt',
  'eps_list_tmdb.txt': '/ids/eps_list_tmdb.txt'
};

/** Proxy one of the downloadable ID lists (with a long cache). */
async function idList(name) {
  const path = ID_LISTS[name];
  if (!path) return null;
  const key = 'ids:' + name;
  const hit = cacheGet(key, 24 * 60 * 60 * 1000);
  if (hit) return hit;
  const res = await fetch(VIDAPI_BASE + path, {
    headers: VIDAPI_KEY ? { 'x-api-key': VIDAPI_KEY } : {},
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    const err = new Error('VidAPI ' + res.status + ' for ' + path);
    err.status = res.status;
    err.upstreamDown = true;
    throw err;
  }
  const text = await res.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return cacheSet(key, { name, count: lines.length, preview: lines.slice(0, 500), totalLines: lines.length });
}

module.exports = {
  VIDAPI_BASE,
  JARVIS_COLOR,
  buildEmbedUrl,
  parseCatalogEpisodeId,
  latestMovies,
  latestTv,
  latestEpisodes,
  stats,
  idList,
  ID_LISTS
};

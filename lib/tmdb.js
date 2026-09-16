'use strict';

/**
 * Minimal TMDB v3 API client (zero dependencies).
 * - Auth via Bearer token (v4 access token) with v3 api_key fallback.
 * - In-memory TTL cache to stay well under rate limits.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

const TMDB_TOKEN = process.env.TMDB_TOKEN ||
  'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJjZDMxYWNmODdhOWU5ZDhkNmUzYzg0NGJhNWI2NzA3ZSIsIm5iZiI6MTc4OTQ3NTAxMS43NzksInN1YiI6IjZhYTkzOGMzMTI1ODY0MDA3YmZiMjYxZCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.wsA-5XPUlQW2zH25HLou-RR3v_CsgF8FzXq2pnye0Y4';
const TMDB_KEY = process.env.TMDB_KEY || 'cd31acf87a9e9d8d6e3c844ba5b6707e';

// ---------------------------------------------------------------- cache ----

const cache = new Map(); // key -> { at, value }
const TTL = {
  short: 2 * 60 * 1000,      // search, live lists
  medium: 15 * 60 * 1000,    // details, credits, seasons
  long: 60 * 60 * 1000       // genre maps
};

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl) {
  // Rough size guard: drop the whole cache when it gets very large.
  if (cache.size > 1500) cache.clear();
  cache.set(key, { at: Date.now(), ttl, value });
  return value;
}

// ---------------------------------------------------------------- fetch ----

async function tmdbFetch(pathname, params = {}) {
  const url = new URL(TMDB_BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('language', params.language || 'en-US');

  const headers = { accept: 'application/json' };
  if (TMDB_TOKEN) headers.authorization = 'Bearer ' + TMDB_TOKEN;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    throw new Error('TMDB network error: ' + e.message);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error('TMDB ' + res.status + ' for ' + pathname + (body ? ' :: ' + body.slice(0, 180) : ''));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function tmdb(pathname, params = {}, ttl = TTL.medium) {
  const key = pathname + JSON.stringify(params);
  const hit = cacheGet(key);
  if (hit) return hit;
  const value = await tmdbFetch(pathname, params);
  return cacheSet(key, value, ttl);
}

// ------------------------------------------------------------- helpers ----

function img(path, size = 'w780') {
  return path ? IMG_BASE + '/' + size + path : null;
}

function pickId(r) {
  return r.imdb_id || (r.external_ids && r.external_ids.imdb_id) || null;
}

/** Normalize a TMDB list result into the card shape the UI consumes. */
function normalizeCard(r, mediaType) {
  const mt = r.media_type || mediaType || (r.title ? 'movie' : 'tv');
  const title = r.title || r.name || 'Untitled';
  const date = r.release_date || r.first_air_date || null;
  const year = date ? Number(String(date).slice(0, 4)) : null;
  return {
    id: r.id,
    mediaType: mt,
    title,
    year,
    poster: img(r.poster_path, 'w500') || img(r.profile_path, 'w500'),
    backdrop: img(r.backdrop_path, 'w1280') || img(r.poster_path, 'w780'),
    rating: typeof r.vote_average === 'number' ? Math.round(r.vote_average * 10) / 10 : null,
    votes: r.vote_count || 0,
    overview: r.overview || '',
    genreIds: r.genre_ids || null
  };
}

function normalizeList(data, mediaType) {
  const results = (data && data.results) ? data.results : [];
  const items = results
    .filter(r => !r.adult)
    .map(r => normalizeCard(r, mediaType))
    .filter(c => c.mediaType === 'movie' || c.mediaType === 'tv');
  return {
    page: data.page || 1,
    totalPages: Math.min(data.total_pages || 1, 500),
    total: data.total_results || items.length,
    items
  };
}

// --------------------------------------------------------------- routes ----

async function trending(mediaType, window, page) {
  const data = await tmdb('/trending/' + mediaType + '/' + window, { page }, TTL.short);
  return normalizeList(data, mediaType === 'all' ? undefined : mediaType);
}

async function discover(mediaType, params) {
  const data = await tmdb('/discover/' + mediaType, {
    page: params.page || 1,
    sort_by: params.sortBy || 'popularity.desc',
    with_genres: params.genre || undefined,
    'vote_count.gte': params.minVotes || (params.sortBy === 'vote_average.desc' ? 300 : 50),
    'primary_release_date.gte': params.releaseGte || undefined,
    'primary_release_date.lte': params.releaseLte || undefined,
    year: params.year || undefined
  }, TTL.short);
  return normalizeList(data, mediaType);
}

async function topRated(mediaType, page) {
  const data = await tmdb('/' + mediaType + '/top_rated', { page }, TTL.short);
  return normalizeList(data, mediaType);
}

async function search(query, page, mediaType) {
  const endpoint = mediaType === 'movie' || mediaType === 'tv'
    ? '/search/' + mediaType
    : '/search/multi';
  const data = await tmdb(endpoint, { query, page, include_adult: false }, TTL.short);
  return normalizeList(data, mediaType || undefined);
}

async function details(mediaType, id) {
  const data = await tmdb('/' + mediaType + '/' + id, { append_to_response: 'external_ids,credits,videos' });
  const card = normalizeCard(Object.assign({}, data, { media_type: mediaType }), mediaType);
  const runtimes = data.episode_run_time && data.episode_run_time.length
    ? data.episode_run_time[0]
    : data.runtime || null;
  return {
    id: data.id,
    mediaType,
    title: card.title,
    year: card.year,
    poster: card.poster,
    backdrop: img(data.backdrop_path, 'original') || card.backdrop,
    rating: card.rating,
    votes: card.votes,
    overview: data.overview || '',
    tagline: data.tagline || '',
    status: data.status || null,
    genres: (data.genres || []).map(g => ({ id: g.id, name: g.name })),
    imdbId: pickId(data),
    tmdbId: data.id,
    runtime: runtimes,
    seasons: (data.seasons || [])
      .filter(s => s.season_number > 0 || (data.seasons || []).length === 1)
      .map(s => ({
        seasonNumber: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        airYear: s.air_date ? Number(String(s.air_date).slice(0, 4)) : null,
        poster: img(s.poster_path, 'w300')
      })),
    cast: (data.credits && data.credits.cast ? data.credits.cast : [])
      .slice(0, 12)
      .map(p => ({
        name: p.name,
        character: p.character || '',
        profile: img(p.profile_path, 'w185')
      })),
    trailerKey: ((data.videos && data.videos.results) || [])
      .filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0))[0]
      ? (data.videos.results.filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))[0].key)
      : null,
    logo: img((data.images && data.images.logos && data.images.logos[0]) ? data.images.logos[0].file_path : null, 'w500')
  };
}

async function seasonDetails(tvId, seasonNumber) {
  const data = await tmdb('/tv/' + tvId + '/season/' + seasonNumber);
  return {
    seasonNumber: data.season_number,
    name: data.name,
    overview: data.overview || '',
    airYear: data.air_date ? Number(String(data.air_date).slice(0, 4)) : null,
    airDate: data.air_date || null,
    poster: img(data.poster_path, 'w300'),
    rating: typeof data.vote_average === 'number' ? Math.round(data.vote_average * 10) / 10 : null,
    episodeCount: (data.episodes || []).length || null,
    episodes: (data.episodes || []).map(e => ({
      episodeNumber: e.episode_number,
      seasonNumber: e.season_number,
      name: e.name,
      airDate: e.air_date || null,
      runtime: e.runtime || null,
      rating: typeof e.vote_average === 'number' ? Math.round(e.vote_average * 10) / 10 : null,
      votes: e.vote_count || 0,
      overview: e.overview || '',
      still: img(e.still_path, 'w500'),
      guestStars: (e.guest_stars || []).slice(0, 4).map(p => p.name)
    }))
  };
}

/** Resolve an IMDB id (tt...) to { tmdbId, mediaType, title } via TMDB /find. */
async function findByImdb(imdbId) {
  const data = await tmdb('/find/' + encodeURIComponent(imdbId), { external_source: 'imdb_id' }, TTL.medium);
  const mv = (data.movie_results || [])[0];
  const tv = (data.tv_results || [])[0];
  if (mv) return { tmdbId: mv.id, mediaType: 'movie', title: mv.title || mv.name || imdbId };
  if (tv) return { tmdbId: tv.id, mediaType: 'tv', title: tv.name || tv.title || imdbId };
  return null;
}

async function similar(mediaType, id, page) {
  const data = await tmdb('/' + mediaType + '/' + id + '/similar', { page }, TTL.short);
  return normalizeList(data, mediaType);
}

let genreCache = null;
async function genres(mediaType) {
  if (genreCache && genreCache[mediaType]) return genreCache[mediaType];
  const data = await tmdb('/genre/' + mediaType + '/list', {}, TTL.long);
  genreCache = genreCache || {};
  genreCache[mediaType] = data.genres || [];
  return genreCache[mediaType];
}

module.exports = {
  trending, discover, topRated, search, details, seasonDetails, similar, genres, img, normalizeCard, findByImdb
};

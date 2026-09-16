'use strict';

/**
 * J.A.R.V.I.S. Streaming Platform
 * Zero-dependency Node.js server.
 *
 * Pages    : /  /movies  /series  /episodes  /hot  /search  /catalog  /history
 *            /watch/movie/:id  /watch/tv/:id/:season/:episode
 * APIs     : /api/trending /api/list /api/search /api/title /api/season
 *            /api/similar /api/genres /api/progress /api/history /api/watchlist
 *            /api/vidapi/stats /api/vidapi/latest/... /api/vidapi/ids/...
 * Health   : /api/health
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const tmdb = require('./lib/tmdb');
const vidapi = require('./lib/vidapi');
const store = require('./lib/store');

// PORT=0 (or unset/invalid) falls back to 3000 — an ephemeral port is useless for previews.
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const EMBED_BASE = vidapi.VIDAPI_BASE;

// ------------------------------------------------------------ utilities ----

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, status, message, extra) {
  sendJson(res, status, Object.assign({ error: message }, extra || {}));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function clampPage(u) {
  const p = Number(u.searchParams.get('page') || 1);
  if (!Number.isFinite(p) || p < 1) return 1;
  return Math.min(Math.floor(p), 500);
}

function serveStatic(res, relPath) {
  const filePath = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'forbidden');
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendError(res, 404, 'not found: ' + relPath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    res.end(buf);
  });
}

// --------------------------------------------------------------- helpers ----

async function resolveWatchContext(mediaType, idParam, season, episode) {
  /** Resolve a TMDB id into the metadata needed to build an embed. */
  const id = Number(idParam);
  if (!Number.isFinite(id)) throw Object.assign(new Error('invalid id'), { status: 400 });

  if (idParam && /^tt/i.test(String(idParam))) {
    // find-by-imdb is not exposed on TMDB v3 publicly; treat as tmdb numeric only.
    throw Object.assign(new Error('IMDB ids must be resolved to TMDB ids first'), { status: 400 });
  }

  const d = await tmdb.details(mediaType, id);
  if (!d.imdbId) {
    // VaPlayer accepts TMDB ids too, so we can proceed.
  }
  return d;
}

function embedFor(details, opts) {
  return vidapi.buildEmbedUrl({
    imdbId: details.imdbId || null,
    tmdbId: details.tmdbId || details.id,
    mediaType: details.mediaType,
    season: opts.season,
    episode: opts.episode,
    color: vidapi.JARVIS_COLOR,
    title: opts.title || null,
    poster: opts.poster || null,
    showTitle: opts.showTitle !== undefined ? opts.showTitle : false,
    autoplay: opts.autoplay !== undefined ? opts.autoplay : true,
    startAt: opts.startAt,
    resumeAt: Number.isFinite(opts.resumeAt) && opts.resumeAt > 5 ? Math.floor(opts.resumeAt) : undefined,
    subUrl: opts.subUrl,
    subLabel: opts.subLabel,
    subLang: opts.subLang,
    subDefault: opts.subDefault,
    thumbnails: opts.thumbnails,
    quality: opts.quality,
    controls: opts.controls !== undefined ? opts.controls : true,
    overlay: opts.overlay !== undefined ? opts.overlay : false
  });
}

// ------------------------------------------------------------ API router ----

async function handleApi(req, res, u) {
  const p = u.pathname;

  // ------------------------------------------------------------ health --
  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      uptime: process.uptime(),
      tmdb: 'configured',
      vidapiBase: EMBED_BASE,
      catalog: 'vaplayer (may be region-blocked; UI degrades gracefully)',
      time: new Date().toISOString()
    });
  }

  // ------------------------------------------------------------- TMDB ---
  if (p === '/api/trending') {
    const mt = u.searchParams.get('mediaType') || 'all';
    const w = u.searchParams.get('window') || 'day';
    const data = await tmdb.trending(mt, w === 'week' ? 'week' : 'day', clampPage(u));
    return sendJson(res, 200, data);
  }

  if (p === '/api/list') {
    const mt = u.searchParams.get('mediaType') === 'tv' ? 'tv' : 'movie';
    const data = await tmdb.discover(mt, {
      page: clampPage(u),
      sortBy: u.searchParams.get('sortBy') || undefined,
      genre: u.searchParams.get('genre') || undefined,
      year: u.searchParams.get('year') || undefined,
      minVotes: u.searchParams.get('minVotes') || undefined
    });
    return sendJson(res, 200, data);
  }

  if (p === '/api/top') {
    const mt = u.searchParams.get('mediaType') === 'tv' ? 'tv' : 'movie';
    const data = await tmdb.topRated(mt, clampPage(u));
    return sendJson(res, 200, data);
  }

  if (p === '/api/search') {
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 200, { page: 1, totalPages: 0, total: 0, items: [] });
    const mt = u.searchParams.get('mediaType');
    const data = await tmdb.search(q, clampPage(u), mt);
    return sendJson(res, 200, data);
  }

  if (p === '/api/genres') {
    const mt = u.searchParams.get('mediaType') === 'tv' ? 'tv' : 'movie';
    return sendJson(res, 200, { genres: await tmdb.genres(mt) });
  }

  let m;

  if ((m = /^\/api\/title\/(movie|tv)\/(\d+)$/.exec(p))) {
    const d = await tmdb.details(m[1], m[2]);
    const nu = store.nextUpForShow(m[1], m[2]);
    return sendJson(res, 200, Object.assign(d, {
      inWatchlist: store.watchlistHas(m[1], m[2]),
      nextUp: nu,
      progress: nu ? nu.seconds : null
    }));
  }

  if ((m = /^\/api\/season\/(\d+)\/(\d+)$/.exec(p))) {
    const data = await tmdb.seasonDetails(m[1], m[2]);
    const watched = store.watchedEpisodesForShow(m[1]);
    return sendJson(res, 200, Object.assign(data, { watched }));
  }

  if ((m = /^\/api\/similar\/(movie|tv)\/(\d+)$/.exec(p))) {
    return sendJson(res, 200, await tmdb.similar(m[1], m[2], clampPage(u)));
  }

  // ---------------------------------------------------------- progress --
  if (p === '/api/find') {
    const imdb = (u.searchParams.get('imdb') || '').trim();
    if (!/^tt\d+$/.test(imdb)) return sendError(res, 400, 'imdb param must match tt\\d+');
    const found = await tmdb.findByImdb(imdb);
    if (!found) return sendError(res, 404, 'no TMDB match for ' + imdb);
    return sendJson(res, 200, found);
  }

  if (p === '/api/progress' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.mediaType || !b.tmdbId) return sendError(res, 400, 'mediaType and tmdbId required');
    const rec = store.setProgress(
      b.mediaType, b.tmdbId, b.season, b.episode,
      b.seconds, b.duration, b.title, b.poster
    );
    return sendJson(res, 200, { ok: true, rec });
  }

  if (p === '/api/progress' && req.method === 'GET') {
    const mt = u.searchParams.get('mediaType');
    const id = u.searchParams.get('tmdbId');
    if (!mt || !id) return sendError(res, 400, 'mediaType and tmdbId required');
    return sendJson(res, 200, {
      rec: store.getProgress(mt, id, u.searchParams.get('season'), u.searchParams.get('episode'))
    });
  }

  if (p === '/api/history' && req.method === 'DELETE') {
    const ok = store.deleteProgress(
      u.searchParams.get('mediaType'),
      u.searchParams.get('tmdbId'),
      u.searchParams.get('season'),
      u.searchParams.get('episode')
    );
    return sendJson(res, 200, { ok });
  }

  if (p === '/api/history') {
    return sendJson(res, 200, { items: store.listProgress(60) });
  }

  // --------------------------------------------------------- watchlist --
  if (p === '/api/watchlist') {
    if (req.method === 'GET') return sendJson(res, 200, { items: store.listWatchlist() });
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b.mediaType || !b.tmdbId) return sendError(res, 400, 'mediaType and tmdbId required');
      const added = store.watchlistAdd(b);
      return sendJson(res, 200, { added });
    }
    if (req.method === 'DELETE') {
      const ok = store.watchlistRemove(u.searchParams.get('mediaType'), u.searchParams.get('tmdbId'));
      return sendJson(res, 200, { ok });
    }
  }

  // ----------------------------------------------------- VidAPI catalog --
  if (p === '/api/vidapi/stats') {
    try {
      return sendJson(res, 200, { ok: true, stats: await vidapi.stats() });
    } catch (e) {
      return sendJson(res, 200, {
        ok: false,
        degraded: true,
        error: e.message,
        note: 'Catalog host unreachable from this network or domain not whitelisted yet. TMDB-driven pages keep working.'
      });
    }
  }

  if ((m = /^\/api\/vidapi\/latest\/(movies|tvshows|episodes)$/.exec(p))) {
    const page = clampPage(u);
    try {
      const fn = m[1] === 'movies' ? vidapi.latestMovies
        : m[1] === 'tvshows' ? vidapi.latestTv
          : vidapi.latestEpisodes;
      return sendJson(res, 200, { ok: true, source: 'vidapi', data: await fn(page) });
    } catch (e) {
      // Graceful degradation: fall back to TMDB so the page never dies.
      const mt = m[1] === 'movies' ? 'movie' : 'tv';
      const fallback = await tmdb.discover(mt, { page, sortBy: 'primary_release_date.desc' });
      return sendJson(res, 200, {
        ok: false,
        degraded: true,
        error: e.message,
        source: 'tmdb-fallback',
        data: fallback
      });
    }
  }

  if ((m = /^\/api\/vidapi\/ids\/([\w.]+)$/.exec(p))) {
    try {
      return sendJson(res, 200, { ok: true, list: await vidapi.idList(m[1]) });
    } catch (e) {
      return sendJson(res, 200, {
        ok: false, degraded: true, error: e.message,
        known: Object.keys(vidapi.ID_LISTS)
      });
    }
  }

  if (p === '/api/vidapi/idlists') {
    return sendJson(res, 200, { ok: true, lists: Object.keys(vidapi.ID_LISTS) });
  }

  if (p === '/api/embed-url') {
    const mt = u.searchParams.get('mediaType') === 'tv' ? 'tv' : 'movie';
    const d = await tmdb.details(mt, u.searchParams.get('tmdbId'));
    const num = (name, dflt) => {
      const v = Number(u.searchParams.get(name));
      return Number.isFinite(v) && v >= 0 ? v : dflt;
    };
    return sendJson(res, 200, {
      embedUrl: embedFor(d, {
        season: num('season', 1),
        episode: num('episode', 1),
        resumeAt: num('resumeAt', undefined),
        startAt: num('startAt', undefined),
        autoplay: u.searchParams.get('autoplay') !== null ? u.searchParams.get('autoplay') !== '0' : undefined,
        subUrl: u.searchParams.get('subUrl') || undefined,
        subLabel: u.searchParams.get('subLabel') || undefined,
        subLang: u.searchParams.get('subLang') || undefined,
        subDefault: u.searchParams.get('subDefault') !== null ? u.searchParams.get('subDefault') !== 'false' : undefined,
        thumbnails: u.searchParams.get('thumbnails') || undefined,
        // Request the ceiling; the player clamps to the highest tier it actually has.
        quality: u.searchParams.get('quality') || process.env.PLAYER_QUALITY || '2160',
        title: d.title,
        poster: d.poster
      })
    });
  }

  return sendError(res, 404, 'unknown API route: ' + p);
}

// ----------------------------------------------------------- page router ----

function page(res, file) {
  serveStatic(res, file);
}

async function handlePage(req, res, u) {
  const p = u.pathname;
  let m;

  if (p === '/') return page(res, 'index.html');
  if (p === '/movies') return page(res, 'browse.html');
  if (p === '/series') return page(res, 'browse.html');
  if (p === '/hot') return page(res, 'hot.html');
  if (p === '/episodes') return page(res, 'episodes.html');
  if (p === '/search') return page(res, 'search.html');
  if (p === '/catalog') return page(res, 'catalog.html');
  if (p === '/history') return page(res, 'history.html');

  if ((m = /^\/title\/(movie|tv)\/(\d+)$/.exec(p))) return page(res, 'title.html');
  // TMDB-id or IMDB-id (tt...) deep links; the player page resolves ids itself.
  if ((m = /^\/watch\/(movie|tv)\/([^/]+)(?:\/(\d+)\/(\d+))?$/.exec(p))) {
    return page(res, 'watch.html');
  }

  return sendError(res, 404, 'page not found: ' + p);
}

// ------------------------------------------------------------------ boot ----

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname.startsWith('/api/')) {
      await handleApi(req, res, u);
    } else if (u.pathname.startsWith('/assets/')) {
      serveStatic(res, u.pathname);
    } else {
      await handlePage(req, res, u);
    }
  } catch (e) {
    console.error('[server]', req.method, u.pathname, '-', e.message);
    const status = e.status || (e.upstreamDown ? 503 : 500);
    if (!res.headersSent) sendError(res, status, e.message);
  }
});

server.listen(PORT, () => {
  console.log('┌──────────────────────────────────────────────────┐');
  console.log('│  J.A.R.V.I.S. STREAMING PLATFORM                 │');
  console.log('│  http://localhost:' + String(PORT).padEnd(24) + '│');
  console.log('│  Player: ' + EMBED_BASE.padEnd(29) + '│');
  console.log('└──────────────────────────────────────────────────┘');
});

module.exports = server;

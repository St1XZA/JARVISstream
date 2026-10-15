'use strict';

/* ════════════════════════════════════════════════════════════════════
   J.A.R.V.I.S. CORE — shared HUD runtime for every page.
   Injects the boot screen + topbar, speaks with the ship's computer
   (server APIs), tracks PLAYER_EVENT telemetry, and handles global search.
   ════════════════════════════════════════════════════════════════════ */

(function () {
  const PAGE = document.body.dataset.page || '';
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ------------------------------------------------------------ api ----
  async function api(path, opts) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || ('HTTP ' + res.status)), { status: res.status, body });
    return body;
  }
  const getJSON = (p) => api(p);
  const postJSON = (p, data) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  const delJSON = (p) => api(p, { method: 'DELETE' });

  // ------------------------------------------- local-first user data ----
  /* Watchlist + watch progress are mirrored into localStorage so the user's
     data always lives in the browser cache, even if the server's data/
     directory is wiped or the machine moves. Reads come from localStorage
     first (instant, offline-safe); writes go to localStorage immediately and
     then best-effort to the server. Keys are namespaced under `jarvis.`. */

  const LS_PROGRESS = 'jarvis.progress'; // { key: rec } — rec same shape as server
  const LS_WATCHLIST = 'jarvis.watchlist'; // [item, ...] newest first

  function lsRead(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota/private mode */ }
  }

  function mediaKey(mediaType, tmdbId, season, episode) {
    const base = String(mediaType) + ':' + String(Number(tmdbId));
    return mediaType === 'tv' && season != null && episode != null
      ? base + ':' + String(Number(season)) + ':' + String(Number(episode))
      : base;
  }

  /** All locally known progress records, newest first. */
  function localProgress() {
    return Object.values(lsRead(LS_PROGRESS, {}))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function localGetProgress(mediaType, tmdbId, season, episode) {
    return lsRead(LS_PROGRESS, {})[mediaKey(mediaType, tmdbId, season, episode)] || null;
  }

  /** Save progress locally, then mirror to the server (best-effort). */
  function setLocalProgress(mediaType, tmdbId, season, episode, seconds, duration, title, poster) {
    const key = mediaKey(mediaType, tmdbId, season, episode);
    const all = lsRead(LS_PROGRESS, {});
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
    all[key] = rec;
    lsWrite(LS_PROGRESS, all);
    // Mirror to the server so cross-browser resume also works; ignore failures.
    postJSON('/api/progress', rec).catch(() => {});
    return rec;
  }

  function localDeleteProgress(mediaType, tmdbId, season, episode) {
    const key = mediaKey(mediaType, tmdbId, season, episode);
    const all = lsRead(LS_PROGRESS, {});
    const existed = !!all[key];
    delete all[key];
    lsWrite(LS_PROGRESS, all);
    delJSON('/api/history?' + new URLSearchParams({ mediaType, tmdbId,
      season: mediaType === 'tv' ? season : '', episode: mediaType === 'tv' ? episode : ''
    })).catch(() => {});
    return existed;
  }

  function localDeleteAllProgress() {
    const all = Object.values(lsRead(LS_PROGRESS, {})); // capture BEFORE clearing
    lsWrite(LS_PROGRESS, {});
    all.forEach(r => { // mirror server cleanup best-effort
      if (r.mediaType) {
        const qs = new URLSearchParams({ mediaType: r.mediaType, tmdbId: r.tmdbId,
          season: r.mediaType === 'tv' ? r.season : '', episode: r.mediaType === 'tv' ? r.episode : ''});
        delJSON('/api/history?' + qs).catch(() => {});
      }
    });
    return all.length;
  }

  function localWatchlistHas(mediaType, tmdbId) {
    return lsRead(LS_WATCHLIST, []).some(w => w.mediaType === mediaType && w.tmdbId === Number(tmdbId));
  }

  function localWatchlistAdd(item) {
    const list = lsRead(LS_WATCHLIST, []);
    if (list.some(w => w.mediaType === item.mediaType && w.tmdbId === Number(item.tmdbId))) return false;
    list.unshift({
      mediaType: item.mediaType,
      tmdbId: Number(item.tmdbId),
      title: item.title || 'Unknown',
      poster: item.poster || null,
      year: item.year || null,
      rating: item.rating || null,
      addedAt: Date.now()
    });
    lsWrite(LS_WATCHLIST, list);
    postJSON('/api/watchlist', item).catch(() => {});
    return true;
  }

  function localWatchlistRemove(mediaType, tmdbId) {
    const before = lsRead(LS_WATCHLIST, []).length;
    const next = lsRead(LS_WATCHLIST, []).filter(w => !(w.mediaType === mediaType && w.tmdbId === Number(tmdbId)));
    lsWrite(LS_WATCHLIST, next);
    delJSON('/api/watchlist?mediaType=' + encodeURIComponent(mediaType) + '&tmdbId=' + encodeURIComponent(tmdbId)).catch(() => {});
    return next.length !== before;
  }

  function localWatchlist() { return lsRead(LS_WATCHLIST, []); }

  // --------------------------------------------------------- helpers ----
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const fmtNum = (n) => (Number(n) || 0).toLocaleString();

  /** Where to send the user when a card is clicked. */
  function watchHref(item) {
    const mt = item.mediaType === 'tv' ? 'tv' : 'movie';
    const id = item.tmdbId || item.id;
    if (mt === 'tv') {
      const nu = item.nextUp || {};
      const s = nu.season || item.season || 1;
      const e = nu.episode || item.episode || 1;
      return '/watch/tv/' + id + '/' + s + '/' + e;
    }
    return '/watch/movie/' + id;
  }

  function posterCard(item, opts) {
    const o = opts || {};
    const mt = item.mediaType === 'tv' ? 'tv' : 'movie';
    const img = item.poster
      ? '<img class="poster" loading="lazy" alt="" src="' + esc(item.poster) + '">'
      : '<div class="noimg">NO SIGNAL</div>';
    const badge = o.showBadge ? '<span class="badge' + (mt === 'tv' ? ' tv' : '') + '">' + (mt === 'tv' ? 'SERIES' : 'FILM') + '</span>' : '';
    const prog = item.pct != null && item.pct > 0
      ? '<span class="progress"><i style="width:' + Math.min(100, item.pct) + '%"></i></span>'
      : '';
    return '<a class="card brackets" href="' + esc(o.href || watchHref(item)) + '">' +
      badge + img +
      '<div class="info"><div class="t" title="' + esc(item.title) + '">' + esc(item.title) + '</div>' +
      '<div class="m"><span>' + esc(item.year || '—') + '</span>' +
      '<span class="r">★ ' + (item.rating != null ? item.rating : '—') + '</span></div></div>' + prog + '</a>';
  }

  function epCardHref(show) { return '/watch/tv/' + show.tmdbId + '/' + (show.season || 1) + '/' + (show.episode || 1); }

  // ------------------------------------------------------ boot screen ----
  function runBoot(steps) {
    const boot = document.createElement('div');
    boot.id = 'boot';
    boot.innerHTML =
      '<div class="boot-inner">' +
      '<div class="boot-ring"></div>' +
      '<div class="boot-title">J.A.R.V.I.S.</div>' +
      '<div id="boot-log"></div>' +
      '<div class="boot-bar"><i id="boot-fill"></i></div>' +
      '</div>';
    document.body.appendChild(boot);
    const log = $('#boot-log', boot);
    const fill = $('#boot-fill', boot);

    return new Promise((resolve) => {
      let i = 0;
      function next() {
        if (i >= steps.length) {
          setTimeout(() => { boot.classList.add('done'); setTimeout(() => boot.remove(), 700); resolve(); }, 420);
          return;
        }
        const s = steps[i++];
        Promise.resolve().then(s.run).then((out) => {
          const cls = s.cls || 'ok';
          log.insertAdjacentHTML('beforeend',
            '<div class="' + cls + '">▸ ' + esc(s.label) + (out ? ' <span class="dim">' + esc(out) + '</span>' : '') + '</div>');
        }).catch((e) => {
          log.insertAdjacentHTML('beforeend',
            '<div class="warn">▸ ' + esc(s.label) + ' <span class="dim">' + esc(e.message || 'failed') + ' — degrading</span></div>');
        }).then(() => {
          fill.style.width = Math.round((i / steps.length) * 100) + '%';
          setTimeout(next, 130 + Math.random() * 160);
        });
      }
      next();
    });
  }

  // ---------------------------------------------------------- topbar ----
  function buildShell() {
    const bar = document.createElement('header');
    bar.id = 'topbar';
    bar.innerHTML =
      '<a class="brand" href="/"><span class="dot"></span>J.A.R.V.I.S.</a>' +
      '<nav>' +
      ['Home:/', 'Films:/movies', 'Series:/series', 'Live:/live', 'Hot:/hot', 'Episodes:/episodes', 'History:/history', 'Catalog:/catalog']
        .map(pair => { const [label, href] = pair.split(':'); return '<a href="' + href + '" data-nav="' + href + '">' + label + '</a>'; })
        .join('') +
      '</nav>' +
      '<div id="global-search"><input id="gs-input" type="text" placeholder="Search the archive…  ⏎" autocomplete="off"><kbd>↵</kbd></div>' +
      '<div id="sys-status"><span class="led"></span><span id="sys-text">SYSTEMS NOMINAL</span></div>';
    document.body.prepend(bar);

    // highlight active nav
    const path = location.pathname;
    $$('#topbar nav a').forEach(a => {
      const h = a.getAttribute('href');
      const active = h === '/' ? path === '/' : path.startsWith(h);
      if (active) a.classList.add('active');
    });

    const input = $('#gs-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        location.href = '/search?q=' + encodeURIComponent(input.value.trim());
      }
    });
    // "/" focuses search from anywhere
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== input && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  // ------------------------------------------------------- telemetry ----
  function healthCheck() {
    return getJSON('/api/health').then(h => {
      const el = $('#sys-status');
      if (!el) return h;
      if (h.vidapiDegraded) { el.classList.add('degraded'); $('#sys-text').textContent = 'CATALOG OFFLINE — TMDB FALLBACK'; }
      else { el.classList.remove('down', 'degraded'); $('#sys-text').textContent = 'SYSTEMS NOMINAL'; }
      return h;
    }).catch(() => {
      const el = $('#sys-status');
      if (el) { el.classList.add('down'); $('#sys-text').textContent = 'LINK DOWN'; }
      return null;
    });
  }

  function updateHealthFromPayload(payload) {
    const el = $('#sys-status');
    if (!el) return;
    if (payload && payload.degraded) {
      el.classList.add('degraded');
      $('#sys-text').textContent = 'CATALOG OFFLINE — TMDB FALLBACK';
    } else if (payload && payload.ok) {
      el.classList.remove('down', 'degraded');
      $('#sys-text').textContent = 'SYSTEMS NOMINAL';
    }
  }

  // ----------------------------------------------------- page scaffolding --
  function stateHTML(id) {
    return '<div id="' + id + '" class="state">INITIALIZING<span class="bar"><i></i></span></div>';
  }
  function setState(id, html, cls) {
    const el = $('#' + id);
    if (!el) return;
    el.className = 'state' + (cls ? ' ' + cls : '');
    el.innerHTML = html;
  }

  function footer() {
    const f = document.createElement('footer');
    f.innerHTML = 'J.A.R.V.I.S. STREAMING INTERFACE · TMDB METADATA · VAPLAYER DELIVERY · ALL SYSTEMS MONITORED';
    document.body.appendChild(f);
  }

  // --------------------------------------------------------- exports ----
  window.JARVIS = {
    PAGE, $, $$, api, getJSON, postJSON, delJSON,
    // local-first user data store (browser cache-backed)
    LS_PROGRESS, LS_WATCHLIST,
    localProgress, localGetProgress, setLocalProgress,
    localDeleteProgress, localDeleteAllProgress,
    localWatchlist, localWatchlistHas, localWatchlistAdd, localWatchlistRemove,
    esc, fmtTime, fmtDate, fmtNum, watchHref, posterCard, epCardHref,
    runBoot, buildShell, healthCheck, updateHealthFromPayload,
    stateHTML, setState, footer
  };
})();

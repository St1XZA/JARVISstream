'use strict';

/**
 * LIVE TV data layer — powered by the free iptv-org database (zero deps).
 * Data source: https://iptv-org.github.io/api/
 *   channels.json   — channel metadata (id, name, country, categories, logo, is_nsfw)
 *   streams.json    — playable stream URLs per channel (url, quality, labels)
 *   blocklist.json  — (channel|feed) entries excluded from playlists
 *   countries.json  / categories.json — browse facet lists
 * All fetched once, cached in memory with a refresh TTL; degrades gracefully
 * when the host (iptv-org.github.io) is unreachable. Streams stay at their
 * original hosts — we only ever link them.
 */

const IPTV_API_BASE = (process.env.IPTV_API_BASE || 'https://iptv-org.github.io/api').replace(/\/+$/, '');

const REFRESH_TTL = 6 * 60 * 60 * 1000; // re-pull catalog every 6 h

const QUALITY_RANK = {
  '2160p': 7, '1440p': 6, '1080p': 5, '720p': 4, '576p': 3, '480p': 3, '360p': 2, '240p': 1, '144p': 1
};

// ------------------------------------------------------------ cache state --

let channelById = new Map();
let streamsByChannel = new Map();
let blockedPairs = new Set();
let countries = [];
let categories = [];
const countsByCategory = new Map();
const countsByCountry = new Map();

const state = {
  updatedAt: 0,
  ok: false,
  error: null,
  loading: null
};

async function fetchJson(pathname) {
  let res;
  try {
    res = await fetch(IPTV_API_BASE + pathname, { signal: AbortSignal.timeout(45000) });
  } catch (e) {
    const err = new Error('iptv-org unreachable: ' + e.message);
    err.upstreamDown = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('iptv-org ' + res.status + ' for ' + pathname);
    err.status = res.status;
    err.upstreamDown = true;
    throw err;
  }
  return res.json();
}

function buildBlocklistKey(entry) {
  return (entry.channel || '') + '|' + (entry.feed || '');
}

function indexLength(key) {
  return streamsByChannel.get(key) || [];
}

/** Highest-quality-first dedup of playable URLs for one channel. */
function usableStreams(channelId) {
  const raw = indexLength(channelId).filter(s =>
    s.url && !blockedPairs.has(channelId + '|' + (s.feed || ''))
  );
  // prefer highest quality; tiebreak — streams labeled Geo-blocked/Not 24/7 sink
  return raw.sort((a, b) =>
    ((QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0)) ||
    ((a.labels || []).length - (b.labels || []).length))
    .slice(0, 6);
}

async function loadAll(force) {
  if (!force && state.loading) return state.loading;
  state.loading = (async () => {
    const [channels, streams, blocklist, countryList, categoryList] = await Promise.all([
      fetchJson('/channels.json'),
      fetchJson('/streams.json'),
      fetchJson('/blocklist.json').catch(() => []), // soft-fail: it's an exclusion list
      fetchJson('/countries.json').catch(() => []),
      fetchJson('/categories.json').catch(() => [])
    ]);

    blockedPairs = new Set((blocklist || []).map(buildBlocklistKey));
    channelById = new Map(channels.map(c => [c.id, c]));

    streamsByChannel = new Map();
    for (const s of streams) {
      if (!s || !s.channel || !s.url) continue; // ungrouped / dead entries
      let list = streamsByChannel.get(s.channel);
      if (!list) { list = []; streamsByChannel.set(s.channel, list); }
      list.push(s);
    }

    countries = countryList || [];
    categories = categoryList || [];

    // facet counts — only channels that actually have a playable stream
    countsByCategory.clear();
    countsByCountry.clear();
    for (const c of channelById.values()) {
      if (!(streamsByChannel.get(c.id) || []).length) continue;
      for (const cat of (c.categories || ['general'])) {
        countsByCategory.set(cat, (countsByCategory.get(cat) || 0) + 1);
      }
      const country = (c.country || '--').toUpperCase();
      countsByCountry.set(country, (countsByCountry.get(country) || 0) + 1);
    }

    state.updatedAt = Date.now();
    state.ok = true;
    state.error = null;
  })().catch(e => {
    state.loading = null;
    state.ok = false;
    state.error = e.message;
    throw e;
  });
  return state.loading;
}

/** Ensure the catalog is loaded; auto-refreshes past the TTL. */
async function ensureData() {
  if (state.ok && Date.now() - state.updatedAt < REFRESH_TTL) {
    // stale: kick off a background refresh, serve what we have now
    if (state.updatedAt && Date.now() - state.updatedAt > REFRESH_TTL) loadAll(true).catch(() => {});
    return state;
  }
  const stale = !state.ok || (state.updatedAt && Date.now() - state.updatedAt > REFRESH_TTL);
  await loadAll(stale);
  return state;
}

// -------------------------------------------------------------- queries ----

function toChannelItem(c) {
  const streams = usableStreams(c.id);
  return {
    id: c.id,
    name: c.name,
    logo: c.logo || null,
    country: (c.country || '').toUpperCase() || null,
    network: c.network || null,
    categories: c.categories || [],
    isNsfw: !!c.is_nsfw,
    quality: streams[0] && streams[0].quality || null,
    urlCount: streams.length,
    feeds: streams.map(s => ({
      url: s.url,
      quality: s.quality || null,
      title: s.title || null,
      labels: s.labels || []
    }))
  };
}

/**
 * Browse channels.
 * opts: { country, category, search, nsfw, limit, offset, sort: 'name'|'feeds' }
 */
function listChannels(opts) {
  const out = { total: 0, items: [] };
  let items = [];
  const term = (opts.search || '').trim().toLowerCase();
  for (const c of channelById.values()) {
    if (opts.country && (c.country || '').toLowerCase() !== String(opts.country).toLowerCase()) continue;
    const cats = c.categories || ['general'];
    if (opts.category && !cats.includes(String(opts.category).toLowerCase())) continue;
    if (c.is_nsfw && !opts.nsfw) continue; // adult content is opt-in only
    if (term) {
      const hay = (c.name + ' ' + (c.alt_names || []).join(' ') + ' ' + (c.network || '')).toLowerCase();
      if (!hay.includes(term)) continue;
    }
    const ss = indexLength(c.id);
    if (!ss.length) continue; // catalog entries without a live link
    items.push(toChannelItem(c));
  }
  if (opts.sort === 'feeds') {
    items.sort((a, b) => b.urlCount - a.urlCount || a.name.localeCompare(b.name));
  } else {
    items.sort((a, b) => a.name.localeCompare(b.name));
  }
  out.total = items.length;
  out.items = items.slice(opts.offset || 0, (opts.offset || 0) + (opts.limit || 60));
  return out;
}

function getChannel(id) {
  const c = channelById.get(String(id));
  return c ? Object.assign(toChannelItem(c), { found: true }) : null;
}

function categoryFacets() {
  return categories.map(c => ({ ...c, count: countsByCategory.get(c.id) || 0 }));
}

const FLAG_OFFSET = 0x1F1A5;
function codeToFlag(code) {
  if (!/^[A-Za-z]{2}$/.test(code || '')) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));
}

function countryFacets() {
  const list = countries.map(c => ({
    code: c.code,
    name: c.name,
    flag: codeToFlag(c.code),
    count: countsByCountry.get(c.code.toUpperCase()) || 0
  })).filter(c => c.count > 0);
  return list.sort((a, b) => b.count - a.count); // busiest countries first
}

function status() {
  return {
    ok: state.ok,
    degraded: !state.ok,
    error: state.error,
    updatedAt: state.updatedAt || null,
    channels: state.ok ? channelById.size : 0,
    liveChannels: state.ok ? Array.from(streamsByChannel.keys()).length : 0,
    blocked: blockedPairs.size,
    categories: state.ok ? categories.length : 0,
    countries: state.ok ? countries.length : 0
  };
}

module.exports = { ensureData, listChannels, getChannel, categoryFacets, countryFacets, status, usableStreams, IPTV_API_BASE };

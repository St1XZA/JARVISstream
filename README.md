# J.A.R.V.I.S. Streaming Platform

An Iron-Man–style streaming interface built on **TMDB metadata** (discovery, search,
details, seasons) and **VidAPI / VaPlayer embeds** (actual playback). Zero npm
dependencies — plain Node.js ≥ 16.

## Quick start

```bash
npm start          # serves http://localhost:3000
```

Or with a custom port:

```bash
PORT=8080 npm start          # POSIX
set PORT=8080 && npm start   # Windows cmd
```

## Pages

| Route | Purpose |
|---|---|
| `/` | Home — hero, Continue Watching, trending / popular / acclaimed rows |
| `/movies`, `/series` | Browse archive with genre chips, sort, load-more |
| `/hot` | Trending spotlight (day/week × all/films/series) |
| `/episodes` | Latest-episodes feed (VidAPI, with TMDB fallback) |
| `/search?q=` | Multi search; a `tt…` query jumps straight to the title |
| `/catalog` | VidAPI library stats, latest catalog items, ID manifests |
| `/history` | Flight Recorder — continue-watching with resume + delete |
| `/live` | Live TV — iptv-org channel database, category/country browse, HLS player |
| `/title/movie/:id`, `/title/tv/:id` | Dossier: cast, seasons, episodes, watchlist |
| `/watch/movie/:id` | Player for films (TMDB numeric id or resolved `tt` id) |
| `/watch/tv/:id/:season/:episode` | Player for episodes |

## APIs (local, proxied)

- `GET /api/health` — uplink status
- `GET /api/trending?mediaType=all|movie|tv&window=day|week&page=`
- `GET /api/list?mediaType=movie|tv&sortBy=&genre=&year=&page=`
- `GET /api/top?mediaType=movie|tv&page=`
- `GET /api/search?q=&page=&mediaType=multi|movie|tv`
- `GET /api/title/:mediaType/:id` — details + `nextUp` resume point
- `GET /api/season/:tvId/:season` — episodes + watched flags
- `GET /api/similar/:mediaType/:id`
- `GET /api/find?imdb=tt…` — IMDB → TMDB resolution
- `GET /api/embed-url?mediaType=&tmdbId=&season=&episode=&resumeAt=&provider=vaplayer|vidfast&…`
  Returns `{ provider, embedUrl }`. `provider` defaults to `vaplayer`; pass
  `provider=vidfast` for the vidfast.vc uplink.
- `GET|POST /api/progress`, `GET|DELETE /api/history`, `GET|POST|DELETE /api/watchlist`
- `GET /api/vidapi/stats`, `/api/vidapi/latest/{movies,tvshows,episodes}?page=`,
  `/api/vidapi/idlists`, `/api/vidapi/ids/:file`

## Player integrations (VidAPI / VaPlayer + vidfast.vc + moviesapi.to)

### VidAPI / VaPlayer (default uplink)
- Movies: `GET {VIDAPI_BASE}/embed/movie/{imdbId|tmdbId}`
- Episodes: `GET {VIDAPI_BASE}/embed/tv/{id}/{season}/{episode}`
- Customization sent by the server: `color` + `primaryColor` (JARVIS orange),
  `title`, `poster`, `showTitle=false`, `autoplay=1`, `resumeAt=<seconds>`,
  `controls=true`, `overlay=false`, and subtitle params
  (`sub_url`, `sub_label`, `sub_lang`, `sub_default`) when provided.
- `PLAYER_EVENT` postMessage uplink: the watch page records
  `playing` / `paused` / `seeked` / `completed` events, throttles progress saves
  (~8 s), persists to `data/progress.json`, shows live telemetry in the sidebar.
- **Auto-next**: on `completed` for TV, the next episode loads after 3 s
  (rolls into the next season automatically at season end).
- **Resume**: `resumeAt` is filled from stored progress; the watch page also
  honors `?resume=1`. Start fresh by clearing the record in `/history`.

### Local-first persistence (browser cache)

The user's watchlist and watch progress are mirrored into **localStorage** so
they always live in the browser cache and survive server data loss, offline
states, and cache clears of the server's `data/` directory:

- `jarvis.progress` — map of progress records (same shape as the server's
  `data/progress.json` values), newest first via `J.localProgress()`.
- `jarvis.watchlist` — array of watchlist entries, newest first.

Reads are **local-first**: the watch page fills `resumeAt` from localStorage,
Continue Watching and the Flight Recorder (`/history`) render from the cache
(and merge any server-only records the cache has not seen). Writes go to
localStorage **immediately**, then mirror to the server best-effort
(`/api/progress`, `/api/watchlist`), so another browser/device also gets the
data without blocking the UI. Telemetry-less uplinks (vidfast/moviesapi) never
generate progress events, so they store nothing anywhere — vaplayer remains the
only uplink with full telemetry.

### vidfast.vc (secondary uplink)

The watch page's **UPLINK → VIDFAST.VC RELAY** toggle switches providers
(`provider=vidfast`, persisted in `localStorage`, key `jarvis.provider`).
- Movies: `{VIDFAST_BASE}/movie/{imdbId|tmdbId}` · TV: `{VIDFAST_BASE}/tv/{id}/{s}/{e}`
- Server sends: `theme` (JARVIS orange, hex without `#`, e.g. `ff7b1f`),
  `autoPlay=true`, `startAt=<resume seconds>`, `sub=<lang>` when a subtitle
  language is set, and on TV `nextButton`/`autoNext` mapped from the
  AUTO-NEXT toggle (autoNext requires nextButton).
- The iframe is created with `allow="…; encrypted-media"` (required by vidfast).
- **No postMessage telemetry**: this host does not document a PLAYER_EVENT
  uplink, so watch progress/resume points and the JARVIS auto-next overlay are
  inactive on this provider; vidfast's own NEXT-EPISODE button and autoNext
  handle episode advance. The stall watchdog is disabled on this uplink.
- **Network filtering**: vidfast fetches its stream sources from rotating
  third-party hosts (random `.rest`/`.cfd` domains). On filtered/corporate
  networks those are commonly DNS-blocked, and the embed then reports
  "500 – Failed to load content" even though the URL is correct — verified
  here: the SAS proxy intercepts those hosts (cert chain shows
  `block.net.sas.com`) and the `.rest` fallback host is NXDOMAIN even on
  public DNS. The watch page surfaces this as an "UPLINK NOT RESPONDING"
  strip with a one-click switch back to vaplayer.
- No API key or domain whitelist is known for vidfast.vc.

### moviesapi.to (tertiary uplink)

Selectable in the watch page's UPLINK SOURCE dropdown (`provider=moviesapi`,
persisted in `localStorage`, key `jarvis.provider`).
- Movies: `{MOVIESAPI_BASE}/movie/{imdbId|tmdbId}`
- TV: `{MOVIESAPI_BASE}/tv/{id}/{s}/{e}` — or the hyphen variant
  `{MOVIESAPI_BASE}/tv/{id}-{s}-{e}` by setting `MOVIESAPI_TV_FORMAT=hyphen`.
- The API documents **no optional parameters** — no theme, autoplay, startAt,
  subtitles, or next-episode controls, and no postMessage telemetry. Embeds are
  pure ID paths; the JARVIS stall watchdog is disabled on this uplink.
- No API key or domain whitelist is known for moviesapi.to.

## Live TV (iptv-org)

The `/live` page brings the free [iptv-org](https://github.com/iptv-org/iptv)
catalog into the interface, globalfreetv-style:

- Browse by category chip, country dropdown, free-text search, and an
  **18+ toggle** — adult channels are excluded by default; flipping the toggle
  (persisted per browser) sends `nsfw=1` and marks visible channels with a red
  badge.
- `/api/iptv/channels?country=us&category=comedy&q=nasa&limit=60` — facet-filtered
  channels (only ones with a playable feed; iptv-org blocklist applied).
- `/api/iptv/categories`, `/api/iptv/countries` — facets with live counts
  (busiest first). `/api/iptv/channel/:id` — one channel + its feeds.
- `/api/iptv/status` — database health (ok/degraded, channel counts). Data is
  fetched from `https://iptv-org.github.io/api/` once, cached in memory, and
  refreshed every 6 h (`IPTV_API_BASE` overrides). If that host is unreachable
  the section degrades to a clear OFFLINE note like the rest of the app.
- Playback is browser-native HLS: hls.js via cdn.jsdelivr with a native-HLS
  fallback (Safari). Feeds are selectable per channel; a fatal playback error
  (CORS, geo-block, dead host) surfaces as a status message with RETRY and the
  alternate-feed picker. Streams play from their original hosts — we only link
  them. If your network blocks the jsdelivr CDN, only native HLS remains.

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `TMDB_TOKEN` | built-in v4 token | Bearer token for TMDB v3 |
| `TMDB_KEY` | built-in v3 key | Fallback key if token is absent |
| `VIDAPI_BASE` | `https://vaplayer.ru` | VaPlayer host |
| `VIDAPI_KEY` | — | Sent as `x-api-key` header + `api_key` param |
| `VIDFAST_BASE` | `https://vidfast.vc` | vidfast.vc uplink base URL |
| `MOVIESAPI_BASE` | `https://moviesapi.to` | moviesapi.to uplink base URL |
| `MOVIESAPI_TV_FORMAT` | `slash` | TV path style: `slash` (`/tv/id/s/e`) or `hyphen` (`/tv/id-s-e`) |
| `PRIMARY_COLOR` | `%23ff7b1f` | Player accent color (URL-encoded hex) |
| `PLAYER_QUALITY` | `1080` | Quality hint sent to the player (`quality` + `maxQuality` params) |
| `IPTV_API_BASE` | `https://iptv-org.github.io/api` | Live TV data source (iptv-org JSON API) |

## Deploying to your website

There is **no build step** — no bundler, no transpile, zero npm dependencies.
`npm install` is a harmless no-op; `public/` files are served exactly as they are.

What you need is a host that runs Node.js ≥ 16:

- **PaaS (easiest)** — Render, Railway, Fly.io, Heroku-style platforms:
  set start command `npm start`, add env vars from the table above, done.
  The server already binds `process.env.PORT`, which these platforms inject.
- **VPS** — `git clone`, then run under a process manager:
  `pm2 start server.js --name jarvis` (or a systemd unit),
  and put nginx/caddy in front to serve your domain over HTTPS.
- **cPanel/shared hosting** — use the "Setup Node.js App" feature
  (application root = this folder, startup file = `server.js`).

Deployment checklist:

1. Set `TMDB_TOKEN` / `TMDB_KEY` / `VIDAPI_KEY` as environment variables on the
   host (don't rely on the built-in fallbacks for a public site).
2. **Whitelist your production domain with VidAPI** — without it the VaPlayer
   iframe refuses to load, even though every other page works.
3. If you front the app with a reverse proxy, add CSP:
   `frame-src https://vaplayer.ru https://vidfast.vc https://moviesapi.to; frame-ancestors 'self'`.
4. Persist the `data/` directory (watch progress + watchlist live there) —
   note the browser localStorage mirror (`jarvis.progress`, `jarvis.watchlist`)
   is self-sufficient, so a fresh `data/` only loses cross-device sync, not
   the user's local history.
   on PaaS, attach a small disk/volume; on a VPS it just works.

## Data & privacy

`data/progress.json` (watch progress) and `data/watchlist.json` are created
automatically with atomic writes. Delete a record from the History page or wipe
the files to reset.

**Privacy posture — no personal information is collected or exposed:**

- **No accounts, no PII.** The app has no sign-up, no emails, no names, no IP
  logging, no cookies for tracking, and **no analytics** — nothing is sent to
  any third party except TMDB (public metadata) and the uplink players you
  explicitly load.
- **User data lives on the client first.** Watchlist + watch progress are
  mirrored into the browser's localStorage (`jarvis.progress`,
  `jarvis.watchlist`, plus UI prefs like `jarvis.provider`). They stay on the
  user's machine; the server mirror (`data/*.json`) is optional and only
  enables cross-device resume.
- **Cleared of identifying trail:** the user-facing History page lets any user
  delete a single record or CLEAR ALL, which removes both the local cache copy
  and the server copy.
- **Secrets:** API keys are server-side env vars only — never shipped to the
  browser. `data/`, logs and `.env` are gitignored so personal watch data and
  runtime logs can't leak into the repository.
- **What the player hosts see:** loading a stream exposes the viewer's IP and
  the title being watched to the uplink host (inherent to any embedded player;
  nothing the app can or does add on top).

## Domain whitelisting (production notes)

VaPlayer embeds only load from **approved domains**. When deploying:

1. Register your production domain(s) in the VidAPI dashboard (origin +
   referrer validation is enforced server-side by the provider).
2. Keep embeds proxied through this server's `/api/embed-url` so parameters
   never leak and the base URL stays configurable.
3. If you front this app with a reverse proxy, set a CSP such as
   `frame-src https://vaplayer.ru https://vidfast.vc https://moviesapi.to; frame-ancestors 'self'`
   on responses.
4. On localhost the player may refuse to load until localhost is whitelisted or
   you deploy behind a real domain; every other page keeps working.

## Degraded mode

`vaplayer.ru` may be unreachable from some networks or regions. In that case:

- `/catalog` and `/episodes` show an amber "UPLINK DEGRADED" panel and fall
  back to TMDB-driven listings.
- The topbar status LED turns amber: `CATALOG OFFLINE — TMDB FALLBACK`.
- Watch pages still resolve metadata; the embed itself depends on VaPlayer
  reachability from the *browser* (which differs from server reachability).

## Dev checks

```bash
npm run check            # syntax-check server.js
node tools/check-pages.js  # syntax-check every page's inline scripts
```

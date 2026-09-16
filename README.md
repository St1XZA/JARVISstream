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
- `GET /api/embed-url?mediaType=&tmdbId=&season=&episode=&resumeAt=&subUrl=…`
- `GET|POST /api/progress`, `GET|DELETE /api/history`, `GET|POST|DELETE /api/watchlist`
- `GET /api/vidapi/stats`, `/api/vidapi/latest/{movies,tvshows,episodes}?page=`,
  `/api/vidapi/idlists`, `/api/vidapi/ids/:file`

## Player integration (VidAPI / VaPlayer)

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

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `TMDB_TOKEN` | built-in v4 token | Bearer token for TMDB v3 |
| `TMDB_KEY` | built-in v3 key | Fallback key if token is absent |
| `VIDAPI_BASE` | `https://vaplayer.ru` | VaPlayer host |
| `VIDAPI_KEY` | — | Sent as `x-api-key` header + `api_key` param |
| `PRIMARY_COLOR` | `%23ff7b1f` | Player accent color (URL-encoded hex) |
| `PLAYER_QUALITY` | `1080` | Quality hint sent to the player (`quality` + `maxQuality` params) |

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
   `frame-src https://vaplayer.ru; frame-ancestors 'self'`.
4. Persist the `data/` directory (watch progress + watchlist live there) —
   on PaaS, attach a small disk/volume; on a VPS it just works.

## Data

`data/progress.json` (watch progress) and `data/watchlist.json` are created
automatically with atomic writes. Delete a record from the History page or wipe
the files to reset.

## Domain whitelisting (production notes)

VaPlayer embeds only load from **approved domains**. When deploying:

1. Register your production domain(s) in the VidAPI dashboard (origin +
   referrer validation is enforced server-side by the provider).
2. Keep embeds proxied through this server's `/api/embed-url` so parameters
   never leak and the base URL stays configurable.
3. If you front this app with a reverse proxy, set a CSP such as
   `frame-src https://vaplayer.ru; frame-ancestors 'self'` on responses.
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

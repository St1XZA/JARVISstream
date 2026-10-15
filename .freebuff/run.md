# Freebuff Preview — Run Doc

## How to run the server

Project root: `C:\Users\Jane\Desktop\Projects` (zero npm dependencies — nothing to install).

The server binds **port 3000** by default, but on this machine a *foreign* node
process (`npm start`, pids 12716/39984 — not started by this workspace) is
squatting on :3000 and serving an old copy of the project from another
directory. This workspace therefore runs on **port 3001**:

```bash
PORT=3001 node server.js
```

Do not kill pids 12716/39984 without checking with the user; if :3000 is ever
freed, plain `node server.js` works again (the env's `PORT=0` normalizes to
3000).

Equivalent: `npm run dev` / `npm start`.

Log files (stdout / stderr):
- `.freebuff/preview-1d435bbf-05db-4a7d-9380-a121f0b5a341.log`
- `.freebuff/preview-1d435bbf-05db-4a7d-9380-a121f0b5a341.log.err`

### Detached launch notes (this machine)

The platform recipe `powershell -NoProfile -Command "(Start-Process -FilePath 'npm.cmd' …)"`
works but keeps the calling shell blocked because node inherits the shell's stdin
pipe. Two workarounds, both verified:

- Simplest (used): `node server.js < /dev/null > <log> 2> <log.err> &` from the
  project root in the bash tool; the node process survives the shell.
- Recipe form works too if you append `< /dev/null` to the whole command.

Confirm with: `netstat -ano | findstr :3000 | findstr LISTENING`, then
`curl http://localhost:3000/api/health` → `{"ok":true,...}`.

## Environment / artifacts

- **No env files and no secrets on disk.** TMDB credentials are embedded as
  fallbacks in `lib/tmdb.js` (override with `TMDB_TOKEN` / `TMDB_KEY`).
- VidAPI base/key: `VIDAPI_BASE` (default `https://vaplayer.ru`), `VIDAPI_KEY`
  (unset). vidfast.vc uplink: `VIDFAST_BASE` (default `https://vidfast.vc`,
  no key). moviesapi.to uplink: `MOVIESAPI_BASE` (default
  `https://moviesapi.to`), TV path style `MOVIESAPI_TV_FORMAT` (`slash` |
  `hyphen`, default `slash`). Player accent: `PRIMARY_COLOR` (default `#ff7b1f`).
- `data/progress.json` + `data/watchlist.json` are created at runtime; safe to
  delete to reset history.
- Nothing needs to be copied from a main checkout — the whole app lives in this
  directory.

## Behavior notes

- `vaplayer.ru` is unreachable from this network: catalog/episodes pages show an
  amber "UPLINK DEGRADED" panel and fall back to TMDB listings. This is expected.
- **This network blocks streaming source hosts** (SAS corporate proxy —
  `block.net.sas.com` cert interception): vidfast.vc's embed shell loads but its
  third-party source hosts are DNS-blocked → their client shows
  "500 – Failed to load content". moviesapi.to TLS is also intercepted.
  Expect vidfast/moviesapi players to fail IN THIS PREVIEW ONLY; on a normal
  home network / deployed domain they work. The watch page now shows an
  "UPLINK NOT RESPONDING" strip for these hosts with one-click recovery to
  vaplayer (whose iframe itself loads fine here).
- The VaPlayer **iframe itself loads in the browser** and emits PLAYER_EVENT
  postMessages; watch progress is saved to `data/progress.json` (verified).
- **Local-first persistence (verified live 2026-10-12)**: watchlist + progress
  mirror into localStorage (`jarvis.progress`, `jarvis.watchlist`). Reads are
  local-first (watch resume, Continue Watching, /history — history page still
  renders when /api/history fails); writes hit localStorage immediately, then
  the server best-effort. Test keys were cleaned up after verification.
- **Uplink selector** (watch page sidebar dropdown "UPLINK SOURCE", persisted in
  `localStorage` as `jarvis.provider`): vaplayer (full telemetry) / vidfast.vc /
  moviesapi.to. vidfast + moviesapi have no postMessage telemetry →
  progress/auto-next overlay inert there; vidfast's native nextButton/autoNext
  handle episode advance. Verified 2026-10-07 on :3001 for movie + TV +
  seamless episode swap (also fixed ep-row off-by-one in watch.html: href parts
  indices 4/5).

## Live TV (iptv-org)

`/live` + `lib/iptv.js`: iptv-org database (channels/streams/blocklist/countries/
categories) cached in memory, refreshed 6h. `/api/iptv/*` routes; UI has
chips/country/search, NSFW off by default, HLS playback via hls.js CDN.
Verified 2026-10-13 on :3001: 31,562 channels indexed, 10,262 with live feeds;
US = 1,625; comedy = 161; US+comedy = 62; NASA search opens and plays an m3u8
live through hls.js (currentTime advances, status LIVE). Some individual stream
hosts may be blocked by this network's SAS proxy (see earlier note) — the player
surfaces playback errors with RETRY + alternate-feed picker.

## Checks

```bash
node --check server.js
node tools/check-pages.js   # syntax-checks all inline page scripts
```

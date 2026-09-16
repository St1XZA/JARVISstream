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
  (unset). Player accent: `PRIMARY_COLOR` (default `#ff7b1f`).
- `data/progress.json` + `data/watchlist.json` are created at runtime; safe to
  delete to reset history.
- Nothing needs to be copied from a main checkout — the whole app lives in this
  directory.

## Behavior notes

- `vaplayer.ru` is unreachable from this network: catalog/episodes pages show an
  amber "UPLINK DEGRADED" panel and fall back to TMDB listings. This is expected.
- The VaPlayer **iframe itself loads in the browser** and emits PLAYER_EVENT
  postMessages; watch progress is saved to `data/progress.json` (verified).

## Checks

```bash
node --check server.js
node tools/check-pages.js   # syntax-checks all inline page scripts
```

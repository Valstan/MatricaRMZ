# MatricaRMZ Watchdog

Tiny external recovery agent for the Electron client. Single-pass Go binary,
launched by a Windows Scheduled Task (at logon + every ~15 min), that detects a
botched update (app exe / shortcuts gone) and silently reinstalls from a local
or downloaded installer. Pure stdlib — no third-party dependencies.

See the full design and rationale in
[`docs/plans/_archive/client-watchdog-agent.md`](../docs/plans/_archive/client-watchdog-agent.md).

## Why an external process

The NSIS one-click installer replaces the install dir
(`%LOCALAPPDATA%\Programs\@matricarmzelectron-app` — electron-builder derives it
from the sanitized package.json `name`, not productName) on every update. If it
dies between the wipe and the reinstall, the app and the in-app updater vanish.
Recovery must run **outside** the app — this binary.

## On-disk contract (no shared code with the app)

The app publishes everything the watchdog needs to a fixed, watchdog-computable
path: `%APPDATA%\MatricaRMZ\watchdog.json` (written by `watchdogHandshakeService`
in `electron-app`). The watchdog reads it instead of touching the app's SQLite
or guessing Electron's `userData` dir. The handshake lives outside the install
dir, so it survives the installer wipe.

Server endpoints used (all unauthenticated — the watchdog has no session):
- `GET  /client/settings?clientId=…` — poll for an owner-issued `reinstall`
- `POST /client/settings/sync-request/ack` — ack that command
- `GET  /updates/latest-meta`, `GET /updates/file/<name>` — download fallback
- `POST /client/watchdog/report` — report `recovered` / `failed` → critical event

## Build

```sh
cd watchdog
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o matricarmz-watchdog.exe .
```

CI builds + vets it on every change under `watchdog/**`
(`.github/workflows/watchdog-build.yml`). The release workflow
(`release-electron-windows.yml`) also builds it for `windows/amd64` and bundles
it into the installer as a `win.extraResources` entry
(`electron-app/build/watchdog/matricarmz-watchdog.exe`). It ships **unsigned** —
code-signing is not available to this project (no CA cert), like the client
itself. The Go stdlib / minimal / single-pass design keeps the AV footprint low.

## Installer integration (Phase 5)

The installer copies the bundled binary to `%APPDATA%\MatricaRMZ\` (outside the
wiped install dir) and registers two per-user Scheduled Tasks — `at logon` and
`every 15 min` — pointing at it (`electron-app/installer/installer.nsh`,
`customInstall` / `customUnInstall`). Per-user, no admin rights.

## Status

Build-verified in CI; installer integration wired and bundled (unsigned). The
**on-machine functional test** (install → delete the install dir → watchdog
reinstalls → uninstall) passed on a real Windows machine (`rmz4val`,
2026-06-22) using a test installer built via `workflow_dispatch`.

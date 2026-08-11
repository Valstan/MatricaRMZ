# MatricaRMZ Watchdog

Tiny external recovery agent for the Electron client. Single-pass Go binary,
launched by a Windows Scheduled Task (at logon + every ~15 min), that detects a
botched update (app exe gone / clearly broken / shortcuts gone) and silently
reinstalls from a local or downloaded installer. Pure stdlib — no third-party
dependencies.

## CLI

- no args — the scheduled pass (backoff-aware, exits untouched on a healthy
  install).
- `--repair` — operator-launched forced pass, wired to the desktop shortcut
  «Восстановить Матрицу РМЗ» that the installer creates (and the client's
  `--restore-shortcuts` maintains). Same ladder, but backoff/state is bypassed;
  a healthy install just gets its shortcuts topped up (exit 0).

Concurrency: each pass claims `%APPDATA%\MatricaRMZ\watchdog-pass.lock`
(stale after 30 min, mirrors the in-app updater's `update.lock` pattern) so a
shortcut-launched `--repair` cannot race a scheduled pass into two concurrent
silent installers.

## Health check

The app is considered present when the exe from the handshake — or, without a
usable handshake, the standard per-user install path (`Programs\MatricaRMZ`,
then the legacy `Programs\@matricarmzelectron-app`) — exists AND is not
*clearly* broken: bad MZ header, or `resources\app.asar` definitively absent
next to the exe. Inconclusive probes (locked file, AV hold) count as healthy —
a false «corrupt» verdict costs a ~116-MB reinstall per backoff period.

When recovery starts because the app is missing/corrupt, the watchdog first
sends a standalone `app_missing` report (critical event
`client.watchdog.app_missing`) — visible to the owner even if the recovery
itself then succeeds.

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

Only a **packaged, non-CDP** client instance writes the handshake: a dev/CDP
instance on the same machine used to overwrite it with its own `appExePath`
(`node_modules\...\electron.exe`) and `apiBaseUrl` (localhost), silently
pointing the watchdog at a dev stack. Guarded in `writeWatchdogHandshake`
(`app.isPackaged` + `-cdp-` userData suffix).

The heal is mutual: the packaged client on startup restores a missing watchdog
exe from its `resources\` and re-registers missing scheduled tasks
(`ensureWatchdogInstalled`, same schtasks parameters as the installer) — the
antivirus sweep that takes the app can take the watchdog too.

Server endpoints used (all unauthenticated — the watchdog has no session):
- `GET  /client/settings?clientId=…` — poll for an owner-issued `reinstall`
- `POST /client/settings/sync-request/ack` — ack that command
- `GET  /updates/latest-meta`, `GET /updates/file/<name>` — download fallback
- `POST /client/watchdog/report` — report `app_missing` / `recovered` /
  `failed` → critical event (the backend must know a kind before a client
  release ships it — strict zod 400s unknown kinds)

## Build

```sh
cd watchdog
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H=windowsgui" -o matricarmz-watchdog.exe .
```

CI builds + vets it on every change under `watchdog/**`
(`.github/workflows/watchdog-build.yml`). The release workflow
(`release-electron-windows.yml`) also builds it for `windows/amd64` and bundles
it into the installer as a `win.extraResources` entry
(`electron-app/build/watchdog/matricarmz-watchdog.exe`). It ships **unsigned** —
code-signing is not available to this project (no CA cert), like the client
itself. The Go stdlib / minimal / single-pass design keeps the AV footprint low.

## Installer integration (Phase 5)

The installer copies the bundled binary to
`%LOCALAPPDATA%\Programs\MatricaRMZ-Watchdog\` and registers two per-user
Scheduled Tasks — `at logon` and `every 15 min` — pointing at it
(`electron-app/installer/installer.nsh`, `customInstall` / `customUnInstall`).
Per-user, no admin rights.

That folder is a **sibling** of the install dir, not a subfolder: the one-click
updater replaces the install dir wholesale, and the watchdog must outlive exactly
that moment. It moved there from `%APPDATA%\MatricaRMZ\` (Roaming) in 2026-08 —
running an unsigned exe out of Roaming on a schedule is a top behavioural-analysis
trigger, and keeping every product executable under one parent is what makes a
single antivirus exclusion possible. See
[`docs/adr/0002-single-executable-root-not-program-files.md`](../docs/adr/0002-single-executable-root-not-program-files.md)
for the decision and for what has to be set up in Kaspersky by hand.

The watchdog's **data** files (`watchdog.json` handshake, `watchdog.log`,
`watchdog-state.json`) stayed in `%APPDATA%\MatricaRMZ\` — only the executable moved.

## Status

Build-verified in CI; installer integration wired and bundled (unsigned). The
**on-machine functional test** (install → delete the install dir → watchdog
reinstalls → uninstall) passed on a real Windows machine (`rmz4val`,
2026-06-22) using a test installer built via `workflow_dispatch`.

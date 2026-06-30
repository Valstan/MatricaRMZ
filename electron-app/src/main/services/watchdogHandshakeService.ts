import { app } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getUpdatesRootDir } from './updatePaths.js';

// Handshake the app publishes for the external watchdog (a separate Go binary
// launched by a Windows Scheduled Task). The watchdog cannot read the app's
// SQLite nor reverse-engineer Electron's productName-based userData dir, so the
// app writes everything the watchdog needs to a FIXED path it can compute from
// %APPDATA% alone:
//   %APPDATA%\MatricaRMZ\watchdog.json
// app.getPath('appData') is the roaming AppData ROOT (without the app name), so
// this path is stable regardless of how productName resolves. The file lives
// outside the install dir (which the NSIS installer wipes), so it survives a
// botched update — exactly the situation the watchdog exists to recover from.
export type WatchdogHandshake = {
  clientId: string;
  apiBaseUrl: string;
  version: string;
  appExePath: string;
  userDataDir: string;
  updatesRootDir: string;
  updaterLogPath: string;
  appLogPath: string;
  updatedAtMs: number;
};

function handshakePath(): string {
  return join(app.getPath('appData'), 'MatricaRMZ', 'watchdog.json');
}

export async function writeWatchdogHandshake(args: {
  clientId: string;
  apiBaseUrl: string;
  version: string;
}): Promise<void> {
  if (process.platform !== 'win32') return;
  const clientId = String(args.clientId ?? '').trim();
  const apiBaseUrl = String(args.apiBaseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!clientId || !apiBaseUrl) return;
  const userDataDir = app.getPath('userData');
  const payload: WatchdogHandshake = {
    clientId,
    apiBaseUrl,
    version: String(args.version ?? '').trim(),
    appExePath: app.getPath('exe'),
    userDataDir,
    updatesRootDir: getUpdatesRootDir(),
    updaterLogPath: join(userDataDir, 'matricarmz-updater.log'),
    appLogPath: join(userDataDir, 'matricarmz.log'),
    updatedAtMs: Date.now(),
  };
  const target = handshakePath();
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Best-effort: the watchdog degrades gracefully if the handshake is absent
    // or stale — it falls back to the standard install path and server download.
  }
}

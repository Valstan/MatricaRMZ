import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from 'electron';

const MAX_LOG_AGE_MS = 10 * 24 * 60 * 60 * 1000;

function pruneLogFile(path: string) {
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return;
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    const lines = raw.split('\n');
    const kept = lines.filter((line) => {
      const m = line.match(/^\[(.+?)\]/);
      if (!m) return true;
      const ts = Date.parse(m[1]);
      if (!Number.isFinite(ts)) return true;
      return ts >= cutoff;
    });
    writeFileSync(path, kept.join('\n').trimEnd() + (kept.length ? '\n' : ''), 'utf8');
  } catch {
    // ignore prune errors
  }
}

export function createFileLogger(app: App) {
  function logToFile(message: string) {
    try {
      const dir = app.getPath('userData');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'matricarmz.log');
      pruneLogFile(path);
      appendFileSync(path, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // ignore
    }
  }

  function getLogPath() {
    return join(app.getPath('userData'), 'matricarmz.log');
  }

  return { logToFile, getLogPath };
}



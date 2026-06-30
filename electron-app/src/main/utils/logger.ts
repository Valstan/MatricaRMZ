import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from 'electron';

const MAX_LOG_AGE_MS = 10 * 24 * 60 * 60 * 1000;

// UTF-8 BOM. Without it, Windows tools that read by locale (Блокнот,
// PowerShell `Get-Content` without `-Encoding utf8`) interpret the file
// as Windows-1251 on a Russian-locale system and Cyrillic comes out
// mojibake. Writing the BOM as the first 3 bytes makes those tools
// auto-detect UTF-8 with no flag.
const BOM = '\uFEFF';

function pruneLogFile(path: string) {
  try {
    const raw = readFileSync(path, 'utf8');
    // Strip any leading BOM(s) before splitting — we'll re-add one when writing.
    const body = raw.replace(/^\uFEFF+/, '');
    if (!body.trim()) return;
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    const lines = body.split('\n');
    const kept = lines.filter((line) => {
      const m = line.match(/^\[(.+?)\]/);
      if (!m) return true;
      const tsRaw = m[1];
      if (!tsRaw) return true;
      const ts = Date.parse(tsRaw);
      if (!Number.isFinite(ts)) return true;
      return ts >= cutoff;
    });
    writeFileSync(path, BOM + kept.join('\n').trimEnd() + (kept.length ? '\n' : ''), 'utf8');
  } catch {
    // ignore prune errors
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a single line to `matricarmz.log` with timestamp. Prepends a
 * UTF-8 BOM on first write so Windows-locale tools auto-detect UTF-8.
 *
 * Exported for use from any main-process module — there used to be three
 * copy-pasted local helpers that wrote to this file without a BOM, which
 * resulted in Cyrillic mojibake when the file was viewed in Notepad or
 * PowerShell on a Russian-locale machine.
 */
export function appendMainLogLine(app: App, message: string): void {
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'matricarmz.log');
    pruneLogFile(path);
    const line = `[${new Date().toISOString()}] ${message}\n`;
    const prefix = fileExists(path) ? '' : BOM;
    appendFileSync(path, prefix + line);
  } catch {
    // ignore — logging must never throw at the call site
  }
}

export function getMainLogPath(app: App): string {
  return join(app.getPath('userData'), 'matricarmz.log');
}

export function createFileLogger(app: App) {
  return {
    logToFile: (message: string) => appendMainLogLine(app, message),
    getLogPath: () => getMainLogPath(app),
  };
}

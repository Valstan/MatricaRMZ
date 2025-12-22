import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from 'electron';

export function createFileLogger(app: App) {
  function logToFile(message: string) {
    try {
      const dir = app.getPath('userData');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'matricarmz.log'), `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // ignore
    }
  }

  function getLogPath() {
    return join(app.getPath('userData'), 'matricarmz.log');
  }

  return { logToFile, getLogPath };
}



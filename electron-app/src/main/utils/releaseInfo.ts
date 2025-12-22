import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export function getReleaseDate(): string {
  try {
    const p = join(app.getAppPath(), 'release-info.json');
    const raw = readFileSync(p, 'utf8');
    const json = JSON.parse(raw) as { releaseDate?: string };
    return json.releaseDate ?? 'unknown';
  } catch {
    return 'unknown';
  }
}



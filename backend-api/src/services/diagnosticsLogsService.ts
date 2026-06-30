import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function logsDir(): string {
  return process.env.MATRICA_LOGS_DIR?.trim() || 'logs';
}

function listLogFiles(): string[] {
  try {
    const dir = logsDir();
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('client-') && f.endsWith('.log'))
      .sort()
      .reverse();
    return files.slice(0, 5).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function findLastClientSyncError(clientId: string): { line: string; at: string } | null {
  const files = listLogFiles();
  const needle = `"clientId":"${clientId}"`;
  for (const file of files) {
    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line) continue;
      if (!line.includes('[ERROR]')) continue;
      if (!line.includes(needle)) continue;
      if (!line.includes('sync')) continue;
      const match = line.match(/^\[(.*?)\]/);
      const at = match?.[1] ?? '';
      return { line, at };
    }
  }
  return null;
}

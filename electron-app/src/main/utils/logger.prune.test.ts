import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendMainLogLine } from './logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let dir = '';
const stubApp = { getPath: () => dir } as never;

function logPath() {
  return join(dir, 'matricarmz.log');
}

function readLines(): string[] {
  return readFileSync(logPath(), 'utf8').replace(/^\uFEFF+/, '').trim().split('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-log-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T09:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('matricarmz.log prune throttle', () => {
  it('первая запись чистит строки старше 10 суток', () => {
    const oldLine = `[${new Date(Date.now() - 11 * DAY_MS).toISOString()}] stale\n`;
    writeFileSync(logPath(), `${oldLine}[2026-10-01T00:00:00.000Z] fresh\n`, 'utf8');
    appendMainLogLine(stubApp, 'hello');
    const lines = readLines();
    expect(lines.some((l) => l.includes('stale'))).toBe(false);
    expect(lines.some((l) => l.includes('fresh'))).toBe(true);
    expect(lines.some((l) => l.includes('hello'))).toBe(true);
  });

  it('повторные записи ротацию не повторяют, после паузы — снова чистят', () => {
    appendMainLogLine(stubApp, 'first');
    const oldLine = `[${new Date(Date.now() - 11 * DAY_MS).toISOString()}] stale\n`;
    writeFileSync(logPath(), readFileSync(logPath(), 'utf8') + oldLine, 'utf8');
    appendMainLogLine(stubApp, 'second');
    expect(readLines().some((l) => l.includes('stale')), 'внутри окна ротации старое не трогаем').toBe(true);

    vi.setSystemTime(new Date('2026-10-02T16:00:01.000Z'));
    appendMainLogLine(stubApp, 'third');
    const lines = readLines();
    expect(lines.some((l) => l.includes('stale'))).toBe(false);
    expect(lines.filter((l) => l.includes('first') || l.includes('second') || l.includes('third'))).toHaveLength(3);
  });
});

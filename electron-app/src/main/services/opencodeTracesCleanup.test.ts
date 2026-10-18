import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { removeOpencodeTraces } from './opencodeTracesCleanup.js';

// Уборка безвозвратна и ходит по профилю оператора, поэтому тест держит её
// границы: что снимается, что рядом остаётся нетронутым и почему устаревший
// `serve.pid` не превращается в выстрел по чужой программе.

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe('removeOpencodeTraces', () => {
  it('снимает раскладку узла и не трогает файлы рядом', async () => {
    const localAppData = tempDir('mrz-local-');
    const userDataDir = tempDir('mrz-userdata-');
    const tempDirRoot = tempDir('mrz-temp-');

    const installDir = join(localAppData, 'Programs', 'MatricaRMZ-OpenCode');
    mkdirSync(join(installDir, 'data'), { recursive: true });
    writeFileSync(join(installDir, 'opencode.exe'), 'binary');
    writeFileSync(join(userDataDir, 'opencode-nodes.json'), '{}');
    writeFileSync(join(userDataDir, 'opencode-agent-session.json'), '{}');
    mkdirSync(join(userDataDir, 'opencode-sandbox'), { recursive: true });
    writeFileSync(join(userDataDir, 'opencode-sandbox', 'ask.txt'), 'x');
    mkdirSync(join(tempDirRoot, 'matricarmz-opencode'), { recursive: true });

    // Чужое: личный каталог CLI, обычные файлы профиля, соседняя папка Матрицы.
    mkdirSync(join(userDataDir, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(userDataDir, 'login-mru.json'), '{}');
    mkdirSync(join(localAppData, 'Programs', 'MatricaRMZ-Watchdog'), { recursive: true });

    const removed = await removeOpencodeTraces({
      localAppData,
      userDataDir,
      tempDir: tempDirRoot,
    });

    expect([...removed].sort()).toEqual(
      [
        installDir,
        join(userDataDir, 'opencode-nodes.json'),
        join(userDataDir, 'opencode-agent-session.json'),
        join(userDataDir, 'opencode-sandbox'),
        join(tempDirRoot, 'matricarmz-opencode'),
      ].sort(),
    );
    expect(existsSync(installDir)).toBe(false);
    expect(existsSync(join(userDataDir, 'opencode-nodes.json'))).toBe(false);
    expect(existsSync(join(userDataDir, 'opencode-sandbox'))).toBe(false);
    expect(existsSync(join(tempDirRoot, 'matricarmz-opencode'))).toBe(false);
    expect(existsSync(join(userDataDir, '.config', 'opencode'))).toBe(true);
    expect(existsSync(join(userDataDir, 'login-mru.json'))).toBe(true);
    expect(existsSync(join(localAppData, 'Programs', 'MatricaRMZ-Watchdog'))).toBe(true);
  });

  it('не гасит процесс по устаревшему serve.pid (PID переиспользован)', async () => {
    const localAppData = tempDir('mrz-local-');
    const userDataDir = tempDir('mrz-userdata-');
    const tempDirRoot = tempDir('mrz-temp-');

    const installDir = join(localAppData, 'Programs', 'MatricaRMZ-OpenCode');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'opencode.exe'), 'binary');
    // Свой же живой PID, но образ — не opencode.exe: уборка обязана отказаться.
    writeFileSync(join(installDir, 'serve.pid'), String(process.pid));

    await removeOpencodeTraces({ localAppData, userDataDir, tempDir: tempDirRoot });

    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(existsSync(installDir)).toBe(false);
  });

  it('чистый профиль: молчит и ничего не возвращает', async () => {
    const localAppData = tempDir('mrz-local-');
    const userDataDir = tempDir('mrz-userdata-');
    const tempDirRoot = tempDir('mrz-temp-');

    await expect(
      removeOpencodeTraces({ localAppData, userDataDir, tempDir: tempDirRoot }),
    ).resolves.toEqual([]);
  });
});

// Проводка рвётся молча: пропадёт вызов в index.ts — тесты сервиса останутся
// зелёными, а следы узла останутся на всём парке.
describe('проводка уборки', () => {
  function src(rel: string): string {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  }

  it('клиент зовёт уборку на старте (рядом с подчисткой прежних каталогов)', () => {
    const index = src('../index.ts');
    expect(index).toContain("import('./services/opencodeTracesCleanup.js')");
    expect(index).toContain('removeOpencodeTraces()');
  });

  it('модуль миграций в уборку не ходит: android-бандл не тянет node:child_process', () => {
    const migrations = src('./migrations/clientSchemaMigrations.ts');
    expect(migrations).not.toContain('opencodeTracesCleanup');
  });
});

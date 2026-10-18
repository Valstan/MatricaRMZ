import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

    // Чужое: личный каталог CLI и обычные файлы профиля.
    mkdirSync(join(userDataDir, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(userDataDir, 'login-mru.json'), '{}');
    mkdirSync(join(localAppData, 'Programs', 'MatricaRMZ-Watchdog'), { recursive: true });

    const removed = await removeOpencodeTraces({
      localAppData,
      userDataDir,
      tempDir: tempDirRoot,
    });

    expect(removed).toContain(installDir);
    expect(existsSync(installDir)).toBe(false);
    expect(existsSync(join(userDataDir, 'opencode-nodes.json'))).toBe(false);
    expect(existsSync(join(userDataDir, 'opencode-agent-session.json'))).toBe(false);
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

  it('чистый профиль не роняет уборку', async () => {
    const localAppData = tempDir('mrz-local-');
    const userDataDir = tempDir('mrz-userdata-');
    const tempDirRoot = tempDir('mrz-temp-');

    await expect(
      removeOpencodeTraces({ localAppData, userDataDir, tempDir: tempDirRoot }),
    ).resolves.toContain(join(localAppData, 'Programs', 'MatricaRMZ-OpenCode'));
  });
});

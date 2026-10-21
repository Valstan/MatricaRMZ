import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

// Менеджер локального движка (контур B): проверяем чистые помощники — каталог
// per-user, аргументы запуска и сверку sha512. Сеть, tar и spawn — смоук на стенде.

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/userData' },
}));

const {
  ENGINE_PORT,
  activeEngineDir,
  engineHealthUrl,
  engineInstallDir,
  engineSpawnArgs,
  engineVersionDir,
  engineVersionsDir,
  integrityMatches,
  setActiveEngine,
  sha512HexMatches,
} = await import('./localAiEngine.js');

describe('engineInstallDir', () => {
  it('на Windows ставит движок per-user, без прав администратора', () => {
    expect(engineInstallDir('win32', 'C:/Users/oper/AppData/Local')).toBe(
      join('C:/Users/oper/AppData/Local', 'Programs', 'MatricaRMZ', 'engine'),
    );
  });

  it('без LOCALAPPDATA уходит в каталог приложения, а не в Program Files', () => {
    expect(engineInstallDir('win32', '')).toBe(join('C:/userData', 'engine'));
  });

  it('на не-Windows — тоже userData, движок там только для отладки', () => {
    expect(engineInstallDir('linux', undefined, '/home/oper/.config/app')).toBe(join('/home/oper/.config/app', 'engine'));
  });
});

describe('engineSpawnArgs', () => {
  it('слушает только loopback и наш порт', () => {
    expect(engineSpawnArgs()).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(ENGINE_PORT)]);
  });

  it('health бьёт в корень loopback-адреса', () => {
    expect(engineHealthUrl()).toBe(`http://127.0.0.1:${ENGINE_PORT}/`);
  });
});

describe('integrityMatches', () => {
  const body = Buffer.from('engine-binary');
  const sri = `sha512-${createHash('sha512').update(body).digest('base64')}`;

  it('совпавший sha512 пропускает', () => {
    expect(integrityMatches(body, sri)).toBe(true);
  });

  it('подменённый файл и мусорная строка — отказ', () => {
    expect(integrityMatches(Buffer.from('engine-binarY'), sri)).toBe(false);
    expect(integrityMatches(body, 'sha1-abc')).toBe(false);
    expect(integrityMatches(body, '')).toBe(false);
  });
});

describe('sha512 манифеста нашего сервера', () => {
  const body = Buffer.from('engine-binary');
  const hex = createHash('sha512').update(body).digest('hex');

  it('совпавший hex пропускает', () => {
    expect(sha512HexMatches(body, hex)).toBe(true);
    expect(sha512HexMatches(body, hex.toUpperCase())).toBe(true);
  });

  it('подмена файла и мусорный манифест — отказ', () => {
    expect(sha512HexMatches(Buffer.from('engine-binarY'), hex)).toBe(false);
    expect(sha512HexMatches(body, 'abc')).toBe(false);
    expect(sha512HexMatches(body, '')).toBe(false);
  });
});

describe('версии движка лежат в подкаталогах', () => {
  it('каталог версии и каталог версий — под корнем движка', () => {
    expect(engineVersionsDir('C:/engine')).toBe(join('C:/engine', 'versions'));
    expect(engineVersionDir('2.0.32', 'C:/engine')).toBe(join('C:/engine', 'versions', '2.0.32'));
  });

  it('без установленного движка активной версии нет', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matricarmz-engine-'));
    expect(await activeEngineDir(root)).toBeNull();
  });

  it('указатель active.json выбирает рабочую версию', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matricarmz-engine-'));
    const dir = engineVersionDir('2.0.32', root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'opencode.exe'), 'stub');
    await setActiveEngine('2.0.32', dir, root);
    const active = await activeEngineDir(root);
    expect(active?.version).toBe('2.0.32');
    expect(active?.dir).toBe(dir);
  });

  it('старая плоская установка тоже считается рабочей версией', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matricarmz-engine-'));
    await writeFile(join(root, 'opencode.exe'), 'stub');
    await writeFile(join(root, '.version'), '2.0.30', 'utf8');
    const active = await activeEngineDir(root);
    expect(active?.version).toBe('2.0.30');
    expect(active?.dir).toBe(root);
  });
});

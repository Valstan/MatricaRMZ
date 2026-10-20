import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// Менеджер локального движка (контур B): проверяем чистые помощники — каталог
// per-user, аргументы запуска и сверку sha512. Сеть, tar и spawn — смоук на стенде.

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/userData' },
}));

const { ENGINE_PORT, engineHealthUrl, engineInstallDir, engineSpawnArgs, integrityMatches } = await import(
  './localAiEngine.js'
);

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

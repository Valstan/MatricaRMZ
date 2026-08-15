import { describe, expect, it } from 'vitest';

import { decideUpdatePlan } from './updateDispatcherService.js';

const LATEST = { version: '3.4.0', fileName: 'MatricaRMZ-Setup-3.4.0.exe', size: 100, sha256: 'a'.repeat(64) };

describe('decideUpdatePlan', () => {
  it('ведёт заглушку и неизвестные версии на свежайший дистрибутив', () => {
    expect(decideUpdatePlan('stub', LATEST)).toEqual({ action: 'update', current: 'stub', latest: LATEST });
    expect(decideUpdatePlan('', LATEST)).toEqual({ action: 'update', current: '(unknown)', latest: LATEST });
  });

  it('ведёт CalVer-клиента на свежайший, хотя числами он «больше»', () => {
    expect(decideUpdatePlan('2026.814.1503', LATEST).action).toBe('update');
  });

  it('клиент новой эпохи на свежем — up-to-date, на старом выпуске — update', () => {
    expect(decideUpdatePlan('3.4.0', LATEST).action).toBe('up-to-date');
    expect(decideUpdatePlan('3.5.0', LATEST).action).toBe('up-to-date');
    expect(decideUpdatePlan('3.1.0', LATEST).action).toBe('update');
  });

  it('без файла обновления на сервере план не строится', () => {
    expect(decideUpdatePlan('3.1.0', null)).toEqual({ action: 'none', reason: 'файл обновления не найден на сервере' });
  });
});

import { describe, expect, it } from 'vitest';

import { decideUpdatePlan, nextCascadeHop, type UpgradeCascadeRule } from './updateDispatcherService.js';

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

describe('nextCascadeHop', () => {
  const RULES: UpgradeCascadeRule[] = [
    { platform: 'windows', below: '3.10.0', via: { version: '3.5.0', fileName: 'MatricaRMZ-Setup-3.5.0.exe' } },
    { platform: 'windows', below: '3.20.0', via: { version: '3.15.0', fileName: 'MatricaRMZ-Setup-3.15.0.exe' } },
    { platform: 'android', below: '3.8.0', via: { version: '3.6.0', fileName: 'matricarmz-3.6.0.apk' } },
  ];

  it('клиент ниже границы ведётся на промежуточный шаг, а не на latest', () => {
    expect(nextCascadeHop('3.2.0', 'windows', RULES)?.version).toBe('3.5.0');
  });

  it('из нескольких недостающих шагов берётся самый ранний', () => {
    // 3.2.0 ниже обеих границ — сначала 3.5.0, после него сработает правило 3.15.0.
    expect(nextCascadeHop('3.2.0', 'windows', RULES)?.version).toBe('3.5.0');
    expect(nextCascadeHop('3.5.0', 'windows', RULES)?.version).toBe('3.15.0');
  });

  it('клиент, прошедший все шаги, идёт сразу на latest', () => {
    expect(nextCascadeHop('3.15.0', 'windows', RULES)).toBeNull();
    expect(nextCascadeHop('3.25.0', 'windows', RULES)).toBeNull();
  });

  it('правила фильтруются по платформе', () => {
    expect(nextCascadeHop('3.2.0', 'android', RULES)?.version).toBe('3.6.0');
    expect(nextCascadeHop('3.7.0', 'android', RULES)).toBeNull();
  });

  it('CalVer-клиент тоже проходит каскад (эпохи учитываются)', () => {
    expect(nextCascadeHop('2026.814.1503', 'windows', RULES)?.version).toBe('3.5.0');
  });

  it('пустая таблица (сегодняшнее состояние) — каскада нет', () => {
    expect(nextCascadeHop('2026.814.1503', 'windows', [])).toBeNull();
  });
});

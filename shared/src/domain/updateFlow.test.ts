import { describe, expect, it } from 'vitest';

import { chooseUpdateFlow, formatUpdateReadyNotice } from './updateFlow.js';

// Правило «отложенное обновление не глушит более новое» (владелец 21.11.2026: «у меня стоит
// 136 версия и не обновляется на следущие»). Живой случай: 3.137.0 скачано и лежит
// отложенным, программа на 3.136.0, сервер уже отдаёт 3.138.0 — а клиент про 3.138.0
// не узнавал никогда и ждал, пока оператор нажмёт «Перезапуск».

describe('выбор действия клиента при обновлении', () => {
  it('отложенное новее установленного — предлагаем его', () => {
    expect(
      chooseUpdateFlow({ currentVersion: '3.136.0', pendingVersion: '3.137.0', serverVersion: '3.137.0' }),
    ).toBe('offer-pending');
  });

  it('сервер знает более новую версию — отложенное выкидываем, а не предлагаем', () => {
    // Ровно тот случай, из-за которого парк стоял на старых версиях.
    expect(
      chooseUpdateFlow({ currentVersion: '3.136.0', pendingVersion: '3.137.0', serverVersion: '3.138.0' }),
    ).toBe('discard-pending');
  });

  it('отложенное уже не нужно (программа на нём или новее) — выкидываем', () => {
    expect(
      chooseUpdateFlow({ currentVersion: '3.137.0', pendingVersion: '3.137.0', serverVersion: '3.138.0' }),
    ).toBe('discard-pending');
    expect(
      chooseUpdateFlow({ currentVersion: '3.138.0', pendingVersion: '3.137.0', serverVersion: '3.138.0' }),
    ).toBe('discard-pending');
  });

  it('отложенного нет — качаем то, что отдал сервер', () => {
    expect(chooseUpdateFlow({ currentVersion: '3.136.0', serverVersion: '3.138.0' })).toBe('download-newer');
  });

  it('обновлений нет — ничего не делаем', () => {
    expect(chooseUpdateFlow({ currentVersion: '3.138.0', serverVersion: '3.138.0' })).toBe('none');
    expect(chooseUpdateFlow({ currentVersion: '3.138.0' })).toBe('none');
  });

  it('сервер не ответил — отложенное всё равно предлагаем, а не теряем', () => {
    // Сеть моргнула: сервер молчит, но отложенное обновление на диске — готово.
    expect(chooseUpdateFlow({ currentVersion: '3.136.0', pendingVersion: '3.137.0' })).toBe('offer-pending');
  });

  it('нумерация эпох учитывается: 3.x новее CalVer, а не наоборот', () => {
    // Клиент со старой нумерацией должен считать 3.138.0 новее себя — иначе обновление
    // для него «откат назад» (см. compareAppVersion).
    expect(
      chooseUpdateFlow({ currentVersion: '2026.714.1503', pendingVersion: '3.137.0', serverVersion: '3.138.0' }),
    ).toBe('discard-pending');
    expect(
      chooseUpdateFlow({ currentVersion: '2026.714.1503', pendingVersion: '3.137.0', serverVersion: '3.137.0' }),
    ).toBe('offer-pending');
  });
});

describe('подпись «обновление ждёт нажатия»', () => {
  it('называет версию и кнопку', () => {
    expect(formatUpdateReadyNotice({ versionLabel: 'Матрица3-РМЗ (138)' })).toContain('Матрица3-РМЗ (138)');
    expect(formatUpdateReadyNotice({ versionLabel: 'Матрица3-РМЗ (138)' })).toContain('Перезапуск');
  });

  it('без версии — тоже говорит, что делать', () => {
    expect(formatUpdateReadyNotice({})).toContain('Перезапуск');
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож против «критическое сообщение снова показали оператору».
//
// Заказ владельца 28.11.2026 (промт КАРМАНА #183): критические сообщения об
// ошибках оператору показывать не надо — они сами уходят в корзину промтов
// КАРМАНА, чтобы разработчик брал их в работу. Баннер застрявшей очереди был
// тем самым местом: он висел вверху и требовал нажать «сообщить администратору».
//
// Порвать это молча легко: вернуть баннер — дело одной строки, типы и линт
// останутся зелёными, а оператор снова будет видеть шум и жать кнопку.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const APP = src('./App.tsx');
const PROBE = src('../../../main/services/sync/localPending.ts');
const MANAGER = src('../../../main/services/syncManager.ts');
const PRELOAD = src('../../../preload/index.ts');
const SYNC_IPC = src('../../../main/ipc/register/authAndSync.ts');

describe('критические сообщения оператору не показываются', () => {
  it('в интерфейсе нет ни текста критического сообщения, ни кнопки «сообщить администратору»', () => {
    expect(APP).not.toContain('Записей не отправлено на сервер');
    expect(APP).not.toContain('Нажмите здесь, чтобы сообщить администратору');
    expect(APP).not.toContain('data-stuck-pending-report');
    expect(APP).not.toContain('data-stuck-pending-copy');
    expect(APP).not.toContain('reportStuckPending');
  });

  it('баннер застрявшей очереди не рисуется вверху', () => {
    // Сам блок баннера с полями счётчика и порога — тоже: оставить его в коде
    // «на всякий случай» значит оставить возможность вернуть шум одним движением.
    expect(APP).not.toContain('stuckPending');
  });
});

describe('застрявшие строки видны там, где надо', () => {
  it('проба считает только pending и берёт возраст по времени правки строки', () => {
    expect(PROBE).toContain("sync_status = 'pending'");
    expect(PROBE).toContain('MIN(updated_at)');
    expect(PROBE).toContain('stuckPendingCutoff');
  });

  it('сводка доходит до статуса синка, который читает сервер', () => {
    expect(MANAGER).toContain('countStuckPendingLocalChanges');
    expect(MANAGER).toContain('stuckPending');
  });
});

describe('критическое событие уходит в корзину промтов с сервера', () => {
  it('клиент про корзину промтов не знает ничего — отправляет сервер', () => {
    // Отправка с клиента сломала бы правило «событие уходит, даже если клиент офлайн».
    expect(PRELOAD).not.toContain('/api/prompts');
    expect(SYNC_IPC).not.toContain('/api/prompts');
    expect(APP).not.toContain('/api/prompts');
  });

  it('ручной путь отчёта остаётся на сервере (на случай, если владелец вернёт кнопку)', () => {
    // Кнопку из интерфейса убрали, но транспорт не выкинули: вернуть её — одна
    // строка, а переписывать серверный маршрут заново незачем.
    expect(SYNC_IPC).toContain("ipcMain.handle('sync:stuckPending:report'");
    expect(SYNC_IPC).toContain('/diagnostics/stuck-pending/report');
  });
});

describe('остальные сообщения, требующие действия оператора, остались', () => {
  it('выгрузка файла и непринятые строки по-прежнему показываются', () => {
    // Их убирать нельзя: они требуют действия оператора (отдать файл, исправить
    // или отбросить строку) — в отличие от критического сообщения, которое
    // теперь уходит в корзину промтов само.
    expect(APP).toContain('data-pending-export-banner');
    expect(APP).toContain('Неотправленные данные лежат файлом на этой машине');
    expect(APP).toContain('строка не принята');
    expect(APP).toContain('строк не принято');
  });
});

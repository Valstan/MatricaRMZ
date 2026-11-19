import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож против «очередь застряла, а программа молчит».
//
// Инцидент 16.11.2026: 617 строк `attribute_values` висели в `pending` неделями — оператор
// об этом не знал, сервер их не видел, автолечение скипалось с `daily_budget_exceeded`.
// Порвать это молча легко: убрать баннер или пробу — типы и линт останутся зелёными,
// а беда вернётся ровно та же.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const APP = src('./App.tsx');
const PROBE = src('../../../main/services/sync/localPending.ts');
const MANAGER = src('../../../main/services/syncManager.ts');
const PRELOAD = src('../../../preload/index.ts');
const SYNC_IPC = src('../../../main/ipc/register/authAndSync.ts');

describe('застрявшие неотправленные строки видны', () => {
  it('оператору показывается баннер про очередь', () => {
    expect(APP).toContain('stuckPending');
    expect(APP).toContain('Записей не отправлено на сервер');
  });

  it('проба считает только pending и берёт возраст по времени правки строки', () => {
    expect(PROBE).toContain("sync_status = 'pending'");
    expect(PROBE).toContain('MIN(updated_at)');
    expect(PROBE).toContain('stuckPendingCutoff');
  });

  it('сводка доходит до статуса синка, который читает интерфейс', () => {
    expect(MANAGER).toContain('countStuckPendingLocalChanges');
    expect(MANAGER).toContain('stuckPending');
  });
});

describe('из баннера можно сообщить администратору', () => {
  it('в баннере есть кнопка, а не только просьба словами', () => {
    expect(APP).toContain('Нажмите здесь, чтобы сообщить администратору');
    expect(APP).toContain('data-stuck-pending-report');
    expect(APP).toContain('reportStuckPending');
  });

  it('кнопка зовёт канал отчёта, а канал доступен из интерфейса', () => {
    expect(PRELOAD).toContain('reportStuckPending');
    expect(SYNC_IPC).toContain("ipcMain.handle('sync:stuckPending:report'");
    // Отчёт уходит на сервер — он кладёт его администратору в чат и во внешние каналы.
    expect(SYNC_IPC).toContain('/diagnostics/stuck-pending/report');
  });

  it('потабличный разбор доезжает до отчёта — видно, ЧТО именно не уходит', () => {
    expect(MANAGER).toContain('byTable');
    expect(SYNC_IPC).toContain('byTable');
  });
});

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

/**
 * Ошибка отправки отчёта (инцидент 23.11.2026, жалоба оператора парка): вместо
 * короткой причины оператор увидел «Не отправилось: <170 КБ страницы Kaspersky>» и
 * отправил эту страницу в чат владельцу. Два правила:
 *  1. текст неудачи — из общего помощника, а не сырое тело ответа;
 *  2. отчёт не должен пропасть, если канал перехватили: текст отчёта копируется.
 */
describe('отчёт администратору не теряется и не выглядит как мусор', () => {
  it('текст неудачи берётся из общего правила, а не из тела ответа', () => {
    expect(SYNC_IPC, 'ошибка отправки — из общего помощника').toContain('httpFailureText(res)');
    expect(SYNC_IPC, 'сырое тело ответа в текст оператору не годится').not.toContain(
      'error: String(res.text',
    );
  });

  it('текст ошибки в баннере обрезается — длинная строка туда не попадает', () => {
    expect(APP).toContain('clipOperatorError');
    expect(APP).toContain('Не отправилось: ${error}');
  });

  it('отчёт можно скопировать и отдать администратору другим каналом', () => {
    expect(APP, 'в баннере есть кнопка копирования отчёта').toContain('data-stuck-pending-copy');
    expect(APP).toContain('Скопировать отчёт');
    expect(APP).toContain('navigator.clipboard?.writeText(stuckReportText)');
    // Текст отчёта собирается на клиенте ДО отправки — иначе при перехвате отчёт пропадёт.
    expect(SYNC_IPC).toContain('formatStuckPendingReport');
    expect(SYNC_IPC).toContain('reportText');
  });
});

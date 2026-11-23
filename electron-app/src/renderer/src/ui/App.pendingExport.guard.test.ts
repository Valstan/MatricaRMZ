import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож против «неотправленные данные лежат файлом, а программа молчит».
//
// Претензия 23.11.2026: у оператора внесено много данных, они не уходят на сервер, и ни
// оператор, ни администратор об этом не знают. Когда клиент пересобирает локальную базу
// (расхождение схемы с сервером), неотправленные строки выгружаются в файл — и если
// реплей прошёл частично, файл остаётся, а данные тихо лежат на диске.
//
// Порвать это молча легко: убрать баннер или забыть про остатки выгрузок — типы и линт
// останутся зелёными, а беда вернётся ровно та же.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const APP = src('./App.tsx');
const MANAGER = src('../../../main/services/syncManager.ts');
const WORKER = src('../../../main/workers/syncWorker.ts');
const PROXY = src('../../../main/services/syncProxy.ts');
const SYNC_IPC = src('../../../main/ipc/register/authAndSync.ts');
const PRELOAD = src('../../../preload/index.ts');
const SERVICE = src('../../../main/services/syncService.ts');
const STATE = src('../../../main/services/sync/pendingExportState.ts');

/** Текст одного IPC-обработчика — от его заголовка до следующего. */
function handlerBody(text: string, channel: string): string {
  const start = text.indexOf(`ipcMain.handle('${channel}'`);
  if (start < 0) return '';
  const next = text.indexOf('ipcMain.handle(', start + 1);
  return text.slice(start, next < 0 ? text.length : next);
}

describe('оператор видит, что его данные не на сервере', () => {
  it('в интерфейсе есть баннер про остатки выгрузок', () => {
    expect(APP).toContain('data-pending-export-banner');
    expect(APP).toContain('На сервере их нет');
  });

  it('в баннере есть действия: показать файл и скопировать отчёт', () => {
    expect(APP).toContain('data-pending-export-reveal');
    expect(APP).toContain('data-pending-export-copy');
    expect(APP).toContain('Показать файл в папке');
    expect(APP).toContain('Скопировать отчёт');
  });

  it('остатки выгрузок доезжают до статуса, который читает интерфейс', () => {
    expect(MANAGER).toContain('readPendingExportState');
    expect(MANAGER).toContain('pendingExport');
    expect(WORKER).toContain('pendingExport');
    expect(PROXY).toContain('pendingExport');
  });

  it('остатки читаются из папки данных программы, а не из базы', () => {
    expect(STATE).toContain('pending-export-');
    expect(STATE).toContain('readdir');
  });
});

describe('причина выгрузки не теряется', () => {
  it('причина едет в файл выгрузки, а не остаётся в логе', () => {
    expect(SERVICE).toContain('exportPendingRowsToDisk(db, reason)');
    expect(SERVICE).toContain('reason');
  });

  it('выгрузка при сбросе базы и при прерванной полной загрузке помечена своей причиной', () => {
    expect(SERVICE).toContain("exportPendingRowsToDisk(db, 'full_pull')");
  });

  it('выгрузку, которую реплей не смог вернуть, чистка не удаляет', () => {
    // В ней — единственная копия неотправленных данных оператора.
    expect(SERVICE).toContain('readKeptExportFiles');
    expect(SERVICE).toContain('markExportFileKept');
    expect(SERVICE).toContain('unmarkExportFileKept');
  });
});

describe('отчёт уходит оператору, а не на сервер', () => {
  it('канал отчёта собирает текст и ничего не отправляет', () => {
    const body = handlerBody(SYNC_IPC, 'sync:pendingExport:report');
    expect(body).not.toBe('');
    expect(body, 'данные лежат на машине — отправлять их на сервер нельзя').not.toContain('httpAuthed');
    expect(body).toContain('formatPendingExportReport');
  });

  it('каналы доступны из интерфейса', () => {
    expect(PRELOAD).toContain('pendingExportReport');
    expect(PRELOAD).toContain('revealPendingExport');
    expect(SYNC_IPC).toContain("ipcMain.handle('sync:pendingExport:report'");
    expect(SYNC_IPC).toContain("ipcMain.handle('sync:pendingExport:reveal'");
  });

  it('показать файл можно только из папки выгрузок — произвольный путь не открывается', () => {
    const body = handlerBody(SYNC_IPC, 'sync:pendingExport:reveal');
    expect(body).toContain('pending-export-');
    expect(body).toContain('showItemInFolder');
    expect(body, 'путь собирается из папки данных программы').toContain("app.getPath('userData')");
  });
});

import { describe, expect, it } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

import { ConfirmedRows } from './confirmedRows.js';

/**
 * Инцидент PC63 (17–25.11.2026): 4 строки `attribute_values` висели в pending неделю,
 * хотя сервер их принял. Причина круга: сервер, получив строку с тем же содержимым,
 * не меняет её номер — pull её не привозит, а клиентское самолечение считает строку
 * «неподтверждённой» и возвращает в очередь. Лечится памятью о подтверждениях:
 * сервер сказал «принял» — значит, строка на сервере есть.
 */
describe('подтверждённые сервером строки', () => {
  it('строка, подтверждённая сервером, узнаётся', () => {
    const rows = new ConfirmedRows();
    rows.remember(SyncTableName.AttributeValues, ['row-1'], 1_000);
    expect(rows.isConfirmed(SyncTableName.AttributeValues, 'row-1', 1_500)).toBe(true);
    expect(rows.isConfirmed(SyncTableName.AttributeValues, 'row-2', 1_500)).toBe(false);
  });

  it('подтверждение другой таблицы не путается с этой', () => {
    const rows = new ConfirmedRows();
    rows.remember(SyncTableName.AttributeValues, ['row-1'], 1_000);
    expect(rows.isConfirmed(SyncTableName.Entities, 'row-1', 1_500)).toBe(false);
  });

  it('протухшее подтверждение больше не защищает строку', () => {
    const rows = new ConfirmedRows();
    rows.remember(SyncTableName.AttributeValues, ['row-1'], 1_000);
    const sevenHoursLater = 1_000 + 7 * 60 * 60_000;
    expect(rows.isConfirmed(SyncTableName.AttributeValues, 'row-1', sevenHoursLater)).toBe(false);
  });

  it('повторное подтверждение продлевает жизнь', () => {
    const rows = new ConfirmedRows();
    rows.remember(SyncTableName.AttributeValues, ['row-1'], 1_000);
    rows.remember(SyncTableName.AttributeValues, ['row-1'], 5_000_000);
    expect(rows.isConfirmed(SyncTableName.AttributeValues, 'row-1', 5_000_500)).toBe(true);
  });

  it('забытое подтверждение перестаёт защищать строку', () => {
    const rows = new ConfirmedRows();
    rows.remember(SyncTableName.AttributeValues, ['row-1'], 1_000);
    rows.forget(SyncTableName.AttributeValues, 'row-1');
    expect(rows.isConfirmed(SyncTableName.AttributeValues, 'row-1', 1_500)).toBe(false);
  });

  it('пустые id не запоминаются', () => {
    const rows = new ConfirmedRows();
    rows.remember(SyncTableName.AttributeValues, ['', '  '], 1_000);
    expect(rows.isConfirmed(SyncTableName.AttributeValues, '', 1_500)).toBe(false);
  });
});

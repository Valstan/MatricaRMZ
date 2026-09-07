import { SyncTableName, SyncTableRegistry, syncRowSchemaByTable } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { toWarehouseLocationInput } from '../services/sync/warehouseLocationsSyncPublisherService.js';

// Справочник складов ведут серверные двери обычными insert/update, мимо пути записи синхронизации.
// Такая строка не получает номера журнала, а инкрементальный pull отбирает изменения условием
// `last_server_seq > since`: в SQL `NULL > n` не TRUE, то есть строка не доедет НИКОГДА. Публикатор
// закрывает разрыв — и его входная строка обязана проходить схему контракта, иначе разрыв
// сменится молчаливым отказом валидации уже на применении.
const dbRow = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'workshop',
  code: 'workshop_3',
  name: 'Цех №3',
  workshopId: '22222222-2222-4222-8222-222222222222',
  isActive: true,
  sortOrder: 3,
  metadataJson: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  deletedAt: null,
  syncStatus: 'pending',
  lastServerSeq: null,
};

describe('публикация справочника складов', () => {
  it('строка публикации проходит схему контракта', () => {
    const input = toWarehouseLocationInput(dbRow);
    const parsed = syncRowSchemaByTable[SyncTableName.WarehouseLocations].safeParse(input.row);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('живая строка публикуется как upsert, снятая — как delete', () => {
    expect(toWarehouseLocationInput(dbRow).type).toBe('upsert');
    expect(toWarehouseLocationInput({ ...dbRow, deletedAt: 1_700_000_002_000 }).type).toBe('delete');
  });

  it('поля переименованы в snake_case ровно так, как ждёт реестр', () => {
    const input = toWarehouseLocationInput(dbRow);
    const fromRegistry = SyncTableRegistry.toSyncRow(SyncTableName.WarehouseLocations, dbRow);
    // Реестром пользуется путь чтения (pull/snapshot), функцией выше — путь публикации.
    // Разойдись они в именах полей — строка уехала бы к клиенту в одном виде, а вернулась бы
    // в снапшоте в другом; сверяем набор ключей, а не только значения.
    //
    // Два поля публикация не отдаёт намеренно, как и публикатор аккаунтов: `last_server_seq`
    // раздаёт журнал (свой номер здесь либо совпал бы с чужой транзакцией, либо ослепил бы
    // клиента, чей курсор стоит ровно на нём), а `sync_status` — местная пометка «опубликовать»,
    // клиенту она не адресована.
    const ledgerOwned = new Set(['last_server_seq', 'sync_status']);
    const expected = Object.keys(fromRegistry).filter((key) => !ledgerOwned.has(key));
    expect(Object.keys(input.row).sort()).toEqual(expected.sort());
  });

  it('пустой справочник не даёт публикатору ничего выдумать', () => {
    // Контроль формы: у строки без имени и кода схема обязана отказать — иначе тест выше
    // зеленел бы на чём угодно.
    const broken = toWarehouseLocationInput({ ...dbRow, name: '', code: '' });
    expect(syncRowSchemaByTable[SyncTableName.WarehouseLocations].safeParse(broken.row).success).toBe(false);
  });
});

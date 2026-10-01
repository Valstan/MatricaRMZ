import { SyncTableName, SyncTableRegistry, syncRowSchemaByTable } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import {
  toContractInput,
  toCounterpartyInput,
  toEngineBrandInput,
} from '../services/sync/dictionarySyncPublisherService.js';

// Словарные зеркала ведут триггеры EAV (0083/0084) мимо пути записи синхронизации —
// тот же разрыв, что у складов и аккаунтов: без seq строка не доедет pull'ом никогда.
// Входная строка публикатора обязана проходить схему контракта, иначе разрыв сменится
// молчаливым отказом валидации уже на применении.
const counterpartyRow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme',
  shortName: 'AC',
  inn: '1234567890',
  kpp: null,
  address: null,
  email: null,
  phone: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  deletedAt: null,
  syncStatus: 'pending',
  lastServerSeq: null,
};

const contractRow = {
  id: '22222222-2222-4222-8222-222222222222',
  number: '20/GOZ-25',
  internalNumber: '20/GOZ-25',
  gozName: 'ГОЗ',
  gozIgk: null,
  gozSeparateAccountNumber: null,
  gozSeparateAccountBank: null,
  gozSeparateAccount: null,
  signedAt: 1_700_000_000_000,
  dueAt: null,
  customerId: '11111111-1111-4111-8111-111111111111',
  comment: null,
  sectionsJson: null,
  executionPartsJson: null,
  paymentsJson: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  deletedAt: null,
  syncStatus: 'pending',
  lastServerSeq: null,
};

const brandRow = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'V-59',
  isActive: true,
  metadataJson: null,
  deprecatedAt: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  deletedAt: null,
  syncStatus: 'pending',
  lastServerSeq: null,
};

const cases = [
  { table: SyncTableName.ErpCounterparties, convert: toCounterpartyInput, row: counterpartyRow },
  { table: SyncTableName.ErpContracts, convert: toContractInput, row: contractRow },
  { table: SyncTableName.DirectoryEngineBrands, convert: toEngineBrandInput, row: brandRow },
] as const;

describe('публикация словарных зеркал', () => {
  it.each(cases)('строка публикации $table проходит схему контракта', ({ table, convert, row }) => {
    const input = convert(row as unknown as Record<string, unknown>);
    const parsed = syncRowSchemaByTable[table].safeParse(input.row);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it.each(cases)('живая строка $table публикуется как upsert, снятая — как delete', ({ convert, row }) => {
    const base = row as unknown as Record<string, unknown>;
    expect(convert(base).type).toBe('upsert');
    expect(convert({ ...base, deletedAt: 1_700_000_002_000 }).type).toBe('delete');
  });

  it.each(cases)('поля $table переименованы в snake_case ровно так, как ждёт реестр', ({ table, convert, row }) => {
    const base = row as unknown as Record<string, unknown>;
    const input = convert(base);
    const fromRegistry = SyncTableRegistry.toSyncRow(table, base);
    // Два поля публикация не отдаёт намеренно, как и публикаторы складов/аккаунтов:
    // `last_server_seq` раздаёт журнал, а `sync_status` — местная пометка «опубликовать».
    const ledgerOwned = new Set(['last_server_seq', 'sync_status']);
    const expected = Object.keys(fromRegistry).filter((key) => !ledgerOwned.has(key));
    expect(Object.keys(input.row).sort()).toEqual(expected.sort());
  });

  it('контроль формы: битый uuid заказчика договор не проходит', () => {
    // Имя в схеме намеренно plain string без min(1) (в БД нет CHECK на непустоту),
    // поэтому контроль «тест краснеет на мусоре» идёт по customer_id договора.
    const brokenContract = toContractInput({ ...contractRow, customerId: 'not-a-uuid' });
    expect(syncRowSchemaByTable[SyncTableName.ErpContracts].safeParse(brokenContract.row).success).toBe(false);
  });
});

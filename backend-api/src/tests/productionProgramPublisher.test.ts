import { SyncTableName, SyncTableRegistry, syncRowSchemaByTable } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import {
  toProductionProgramInput,
  toProductionProgramLineInput,
} from '../services/sync/productionProgramSyncPublisherService.js';

// План ПП ведёт серверная дверь обычными insert/update, мимо пути записи
// синхронизации. Строка без номера журнала не доедет инкрементальным pull'ом
// НИКОГДА. Публикатор закрывает разрыв — и его входные строки обязаны проходить
// схему контракта.
const UID = '11111111-1111-4111-8111-111111111111';
const BASE = { id: UID, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, deletedAt: null, syncStatus: 'pending', lastServerSeq: null };

describe('публикация зеркала производственной программы', () => {
  const program = {
    ...BASE,
    periodStart: 1_762_000_000_000,
    periodEnd: 1_762_700_000_000,
    shop: 'Цех № 1',
    title: 'ПП Цех 1 с 01.11 по 15.11.2026',
    status: 'draft',
    signatureSlots: null,
  };
  const line = {
    ...BASE,
    programId: UID,
    orderNo: 1,
    contractId: UID,
    groupLabel: 'ООО «Заказчик» № 125/2026',
    contractKind: 'military',
    engineId: UID,
    engineMark: 'Д-245',
    engineNumber: '001',
    state: 'restoration',
    shippingPlanAt: null,
    factors: '',
    note: '',
  };

  it('erp_production_programs: строка публикации проходит схему контракта', () => {
    const input = toProductionProgramInput({ ...program });
    const parsed = syncRowSchemaByTable[SyncTableName.ErpProductionPrograms].safeParse(input.row);
    expect(parsed.success, parsed.success ? '' : JSON.stringify((parsed as { error: { issues: unknown } }).error.issues)).toBe(true);
  });

  it('erp_production_program_rows: строка публикации проходит схему контракта', () => {
    const input = toProductionProgramLineInput({ ...line });
    const parsed = syncRowSchemaByTable[SyncTableName.ErpProductionProgramRows].safeParse(input.row);
    expect(parsed.success, parsed.success ? '' : JSON.stringify((parsed as { error: { issues: unknown } }).error.issues)).toBe(true);
  });

  it('живая строка — upsert, снятая — delete', () => {
    expect(toProductionProgramInput({ ...program }).type).toBe('upsert');
    expect(toProductionProgramInput({ ...program, deletedAt: 1_700_000_002_000 }).type).toBe('delete');
    expect(toProductionProgramLineInput({ ...line }).type).toBe('upsert');
    expect(toProductionProgramLineInput({ ...line, deletedAt: 1_700_000_002_000 }).type).toBe('delete');
  });

  it('поля в snake_case ровно как ждёт реестр (кроме ledger-owned)', () => {
    const ledgerOwned = new Set(['last_server_seq', 'sync_status']);
    for (const [table, input, row] of [
      [SyncTableName.ErpProductionPrograms, toProductionProgramInput({ ...program }), program] as const,
      [SyncTableName.ErpProductionProgramRows, toProductionProgramLineInput({ ...line }), line] as const,
    ]) {
      const fromRegistry = SyncTableRegistry.toSyncRow(table, { ...row });
      const expected = Object.keys(fromRegistry).filter((key) => !ledgerOwned.has(key));
      expect(Object.keys(input.row).sort()).toEqual(expected.sort());
    }
  });
});

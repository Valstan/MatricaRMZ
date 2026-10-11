import { SyncTableName, SyncTableRegistry, syncRowSchemaByTable } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import {
  toPpeCardNormInput,
  toPpeIssueCardInput,
  toPpeIssueEntryInput,
  toPpeNormLineInput,
  toPpeNormSetInput,
} from '../services/sync/ppeSyncPublisherService.js';

// Зеркало Кладовщика ведут серверные двери обычными insert/update, мимо пути записи
// синхронизации. Строка без номера журнала не доедет инкрементальным pull'ом НИКОГДА.
// Публикатор закрывает разрыв — и его входная строка обязана проходить схему контракта.
const UID = '11111111-1111-4111-8111-111111111111';
const BASE = { id: UID, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, deletedAt: null, syncStatus: 'pending', lastServerSeq: null };

const CASES = [
  {
    table: SyncTableName.PpeNormSets,
    map: toPpeNormSetInput,
    row: { ...BASE, name: 'Слесарь РМЦ', postTitle: 'Слесарь', departmentId: null, validFrom: 1_700_000_000_000, validTo: null },
  },
  {
    table: SyncTableName.PpeNormLines,
    map: toPpeNormLineInput,
    row: { ...BASE, normSetId: UID, nomenclatureId: UID, qty: 2, wearMonths: 12 },
  },
  {
    table: SyncTableName.PpeIssueCards,
    map: toPpeIssueCardInput,
    row: { ...BASE, employeeId: UID, openedAt: 1_700_000_000_000, closedAt: null },
  },
  {
    table: SyncTableName.PpeCardNorms,
    map: toPpeCardNormInput,
    row: { ...BASE, cardId: UID, normSetId: UID, assignedAt: 1_700_000_000_000 },
  },
  {
    table: SyncTableName.PpeIssueEntries,
    map: toPpeIssueEntryInput,
    row: { ...BASE, cardId: UID, nomenclatureId: UID, qty: 1, issuedAt: 1_700_000_000_000, documentId: UID },
  },
] as const;

describe('публикация зеркала Кладовщика', () => {
  for (const { table, map, row } of CASES) {
    it(`${table}: строка публикации проходит схему контракта`, () => {
      const input = map({ ...row });
      const parsed = syncRowSchemaByTable[table].safeParse(input.row);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    });

    it(`${table}: живая строка — upsert, снятая — delete`, () => {
      expect(map({ ...row }).type).toBe('upsert');
      expect(map({ ...row, deletedAt: 1_700_000_002_000 }).type).toBe('delete');
    });

    it(`${table}: поля в snake_case ровно как ждёт реестр (кроме ledger-owned)`, () => {
      const input = map({ ...row });
      const fromRegistry = SyncTableRegistry.toSyncRow(table, { ...row });
      const ledgerOwned = new Set(['last_server_seq', 'sync_status']);
      const expected = Object.keys(fromRegistry).filter((key) => !ledgerOwned.has(key));
      expect(Object.keys(input.row).sort()).toEqual(expected.sort());
    });
  }
});

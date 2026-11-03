import { SyncTableName, SyncTableRegistry, syncRowSchemaByTable } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import {
  toPpeAbsenceInput,
  toPpeCardNormInput,
  toPpeCollectiveInput,
  toPpeCollectiveLineInput,
  toPpeEmployeeCardInput,
  toPpeGroupInput,
  toPpeGroupMemberInput,
  toPpeGroupNormInput,
  toPpeIssueCardInput,
  toPpeIssueEntryInput,
  toPpeNormLineInput,
  toPpeNormLineSpecInput,
  toPpeNormSetInput,
  toPpeOccupationRefInput,
  toPpePrintTemplateInput,
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
    // Приказ о СИЗ: набор ссылается на профессию приказа и хранит подпись источника.
    row: { ...BASE, name: 'Слесарь РМЦ', postTitle: 'Слесарь', departmentId: null, gender: 'M', season: 'winter', isDuty: false, occupationId: null, sourceKind: 'ton', sourceLabel: 'Пункт № 4516', validFrom: 1_700_000_000_000, validTo: null },
  },
  {
    table: SyncTableName.PpeNormLines,
    map: toPpeNormLineInput,
    // Приказ о СИЗ: строка ссылается на «приказную» строку, единицу и форму срока.
    row: { ...BASE, normSetId: UID, nomenclatureId: UID, qty: 2, wearMonths: 12, specId: null, unit: 'шт.', wearKind: 'months' },
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
  // Фаза 2, PR-1. NULL-документ доввода истории тоже проходит схему.
  {
    table: SyncTableName.PpeIssueEntries,
    map: toPpeIssueEntryInput,
    row: { ...BASE, cardId: UID, nomenclatureId: UID, qty: 1, issuedAt: 1_700_000_000_000, documentId: null },
  },
  {
    table: SyncTableName.PpeAbsences,
    map: toPpeAbsenceInput,
    row: { ...BASE, employeeId: UID, fromMs: 1_700_000_000_000, toMs: 1_700_010_000_000, kind: 'vacation' },
  },
  {
    table: SyncTableName.PpeGroups,
    map: toPpeGroupInput,
    row: { ...BASE, name: 'Зимники' },
  },
  {
    table: SyncTableName.PpeGroupMembers,
    map: toPpeGroupMemberInput,
    row: { ...BASE, groupId: UID, employeeId: UID },
  },
  {
    table: SyncTableName.PpeGroupNorms,
    map: toPpeGroupNormInput,
    row: { ...BASE, groupId: UID, normSetId: UID },
  },
  {
    table: SyncTableName.PpeCollectives,
    map: toPpeCollectiveInput,
    row: { ...BASE, departmentId: UID, warehouseId: UID, documentId: null, distributedAt: null },
  },
  {
    table: SyncTableName.PpeCollectiveLines,
    map: toPpeCollectiveLineInput,
    row: { ...BASE, collectiveId: UID, employeeId: UID, nomenclatureId: UID, qty: 3 },
  },
  // Приказ о СИЗ (Минтруд 767н): профессии, «приказные» строки норм, личная карточка
  // СИЗ по форме приложения №3 и шаблоны печатных форм.
  {
    table: SyncTableName.PpeOccupationRef,
    map: toPpeOccupationRefInput,
    row: { ...BASE, code: '1511', postTitle: 'Кладовщик', tonKind: 'ton', tonLabel: 'Пункт № 1511', tonYear: 2021, departmentId: null, isActive: true },
  },
  {
    table: SyncTableName.PpeNormLineSpecs,
    map: toPpeNormLineSpecInput,
    row: { ...BASE, occupationId: UID, name: 'Костюм для защиты от механических воздействий (истирания)', ppeType: 'Одежда специальная защитная', qty: 1, unit: 'шт.', wearKind: 'months', wearMonths: 12, sortOrder: 1, sourceRef: '1 шт.', sourceKind: 'ton', sourceLabel: 'Пункт № 1511', nomenclatureId: UID },
  },
  {
    table: SyncTableName.PpeEmployeeCards,
    map: toPpeEmployeeCardInput,
    row: { ...BASE, employeeId: UID, fullName: 'Иванов Иван Иванович', lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович', personnelNo: '0042', departmentId: null, departmentName: 'Склад', postTitle: 'Кладовщик', occupationId: null, gender: 'M', height: '176', sizeClothes: '50', sizeShoes: '43', sizeGloves: 'L', sizeHeadgear: '56', sizeRespirator: null, sizeOd: null, sizeHands: null, hireDate: 1_700_000_000_000, positionChangedDate: null, occupationNotes: null, issuedBy: null, preparedBy: null, preparedAt: null },
  },
  {
    table: SyncTableName.PpePrintTemplates,
    map: toPpePrintTemplateInput,
    row: { ...BASE, ownerId: 'shared', formKey: 'ppe_card', name: 'Личная карточка СИЗ', layoutJson: '{"sections":[]}', isDefault: false, updatedAt: 1_700_000_001_000, updatedBy: 'system' },
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

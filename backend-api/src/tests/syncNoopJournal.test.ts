/**
 * Журнал синхронизации — лог ИЗМЕНЕНИЙ. Пока он писал каждый пришедший пуш
 * подряд, клиент с зависшим pending раздувал журнал на ровном месте
 * (прод-инцидент 03.11.2026: 3.6 млн записей attribute_values за сутки от
 * одной машины, 89% журнала).
 *
 * Тест закрывает правило: содержимое не изменилось → в журнал строка не идёт,
 * а подтверждение клиенту уходит как обычно.
 */
import { describe, expect, it } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

import { isUnchangedAttributeValueRow, isUnchangedSyncRow } from '../services/sync/syncWriteService.js';

const stored = {
  valueJson: '"Кладовщик"',
  updatedAt: 1793686658884,
  deletedAt: null,
};

describe('журнал синхронизации: неизменившаяся строка — не изменение', () => {
  it('тот же id, значение, время и признак удаления — строка не изменилась', () => {
    expect(
      isUnchangedAttributeValueRow(stored, {
        id: '35b997f5-700e-4bd3-bce5-1c6f11976a5c',
        value_json: '"Кладовщик"',
        updated_at: 1793686658884,
        deleted_at: null,
      }),
    ).toBe(true);
  });

  it('изменилось значение — это изменение', () => {
    expect(
      isUnchangedAttributeValueRow(stored, {
        id: 'x',
        value_json: '"Инженер"',
        updated_at: 1793686658884,
        deleted_at: null,
      }),
    ).toBe(false);
  });

  it('изменилось время правки — это изменение', () => {
    expect(
      isUnchangedAttributeValueRow(stored, {
        id: 'x',
        value_json: '"Кладовщик"',
        updated_at: 1793686658885,
        deleted_at: null,
      }),
    ).toBe(false);
  });

  it('строка удалена (deleted_at) — это изменение', () => {
    expect(
      isUnchangedAttributeValueRow(stored, {
        id: 'x',
        value_json: '"Кладовщик"',
        updated_at: 1793686658884,
        deleted_at: 1793686658884,
      }),
    ).toBe(false);
  });

  it('строки на сервере ещё нет — это изменение', () => {
    expect(
      isUnchangedAttributeValueRow(null, {
        id: 'x',
        value_json: '"Кладовщик"',
        updated_at: 1793686658884,
        deleted_at: null,
      }),
    ).toBe(false);
  });

  it('строка "null" и пустое значение — одно и то же', () => {
    // Прод-случай: клиент присылал value_json="null", сервер хранил NULL.
    expect(
      isUnchangedAttributeValueRow(
        { valueJson: null, updatedAt: 1, deletedAt: null },
        { id: 'x', value_json: 'null', updated_at: 1, deleted_at: null },
      ),
    ).toBe(true);
  });
});

/**
 * Строки списка деталей двигателя (E3) — тот же класс, но по-другому: правило
 * применено к одной таблице, а строки ведёт клиент, поэтому повторный push
 * неизменённой строки создавал новый seq и новую запись журнала (инцидент
 * 25.11.2026 — 1244 записи на 622 строки).
 */
const storedLine = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  operationId: 'bbbbbbbb-1111-2222-3333-444444444444',
  engineEntityId: 'cccccccc-1111-2222-3333-444444444444',
  lineKey: 'part-1',
  sortOrder: 1,
  partId: 'dddddddd-1111-2222-3333-444444444444',
  brandManaged: false,
  partName: 'Вал',
  assemblyUnitNumber: '',
  partNumber: '',
  stampedNumber: '',
  bomVariantGroup: null,
  quantity: 1,
  present: true,
  actualQty: 0,
  repairableQty: 0,
  scrapQty: 0,
  replaceQty: 0,
  replenishmentBranch: null,
  scrapReason: null,
  inCompletenessAct: false,
  inDefectAct: false,
  inCompletenessActOverride: null,
  inDefectActOverride: null,
  hasOwnNumber: null,
  hasOwnNumberOverride: null,
  selected: false,
  photosJson: null,
  createdAt: 1000,
  updatedAt: 5000,
  deletedAt: null,
  lastServerSeq: 6404108,
  syncStatus: 'synced',
};

const incomingLine = {
  id: storedLine.id,
  operation_id: storedLine.operationId,
  engine_entity_id: storedLine.engineEntityId,
  line_key: storedLine.lineKey,
  sort_order: storedLine.sortOrder,
  part_id: storedLine.partId,
  brand_managed: storedLine.brandManaged,
  part_name: storedLine.partName,
  assembly_unit_number: storedLine.assemblyUnitNumber,
  part_number: storedLine.partNumber,
  stamped_number: storedLine.stampedNumber,
  bom_variant_group: storedLine.bomVariantGroup,
  quantity: storedLine.quantity,
  present: storedLine.present,
  actual_qty: storedLine.actualQty,
  repairable_qty: storedLine.repairableQty,
  scrap_qty: storedLine.scrapQty,
  replace_qty: storedLine.replaceQty,
  replenishment_branch: storedLine.replenishmentBranch,
  scrap_reason: storedLine.scrapReason,
  in_completeness_act: storedLine.inCompletenessAct,
  in_defect_act: storedLine.inDefectAct,
  in_completeness_act_override: storedLine.inCompletenessActOverride,
  in_defect_act_override: storedLine.inDefectActOverride,
  has_own_number: storedLine.hasOwnNumber,
  has_own_number_override: storedLine.hasOwnNumberOverride,
  selected: storedLine.selected,
  photos_json: storedLine.photosJson,
  created_at: storedLine.createdAt,
  updated_at: storedLine.updatedAt,
  deleted_at: storedLine.deletedAt,
  // Служебные поля клиента: они меняются сами по себе и правку не означают.
  sync_status: 'pending',
  last_server_seq: null,
};

describe('журнал синхронизации: строки списка деталей — то же правило', () => {
  it('тот же id и то же содержимое — строка не изменилась', () => {
    expect(isUnchangedSyncRow(SyncTableName.ErpEngineInventoryLines, storedLine, incomingLine)).toBe(true);
  });

  it('служебные поля (sync_status, last_server_seq) не делают строку изменением', () => {
    expect(
      isUnchangedSyncRow(SyncTableName.ErpEngineInventoryLines, storedLine, {
        ...incomingLine,
        sync_status: 'pending',
        last_server_seq: 6404999,
      }),
    ).toBe(true);
  });

  it('изменилось количество — это изменение', () => {
    expect(
      isUnchangedSyncRow(SyncTableName.ErpEngineInventoryLines, storedLine, { ...incomingLine, quantity: 2 }),
    ).toBe(false);
  });

  it('изменилось время правки — это изменение', () => {
    expect(
      isUnchangedSyncRow(SyncTableName.ErpEngineInventoryLines, storedLine, { ...incomingLine, updated_at: 5001 }),
    ).toBe(false);
  });

  it('строка удалена (deleted_at) — это изменение', () => {
    expect(
      isUnchangedSyncRow(SyncTableName.ErpEngineInventoryLines, storedLine, { ...incomingLine, deleted_at: 5000 }),
    ).toBe(false);
  });

  it('строки на сервере ещё нет — это изменение', () => {
    expect(isUnchangedSyncRow(SyncTableName.ErpEngineInventoryLines, null, incomingLine)).toBe(false);
  });
});

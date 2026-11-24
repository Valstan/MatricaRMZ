import { describe, expect, it } from 'vitest';

import { PermissionCode } from './permissions.js';
import { canWriteRepairHistory, repairHistoryWritePermissions } from './repairHistoryWriteGate.js';

/**
 * Гейт записи истории ремонта — один на клиенте и на сервере (план #114, шаг 24).
 *
 * Прежде UI-гейт ленты истории был `engines.edit`, а серверный — `operations.edit`:
 * технолог видел кнопку, а сервер резал строку (`forbidden:repair_history_entry`).
 * Запись оставалась только на планшете — ровно симптом владельца.
 */
describe('гейт истории ремонта', () => {
  it('ручная запись — только operations.edit', () => {
    expect(repairHistoryWritePermissions('manual')).toEqual([PermissionCode.OperationsEdit]);
    expect(canWriteRepairHistory({ [PermissionCode.OperationsEdit]: true }, 'manual')).toBe(true);
    expect(canWriteRepairHistory({ [PermissionCode.EnginesEdit]: true }, 'manual')).toBe(false);
  });

  it('метка этапа — work_sheets.edit ИЛИ operations.edit', () => {
    expect(repairHistoryWritePermissions('stage')).toEqual([
      PermissionCode.WorkSheetsEdit,
      PermissionCode.OperationsEdit,
    ]);
    expect(canWriteRepairHistory({ [PermissionCode.WorkSheetsEdit]: true }, 'stage')).toBe(true);
    expect(canWriteRepairHistory({ [PermissionCode.OperationsEdit]: true }, 'stage')).toBe(true);
    expect(canWriteRepairHistory({ [PermissionCode.EnginesEdit]: true }, 'stage')).toBe(false);
  });

  it('строка этапа работ — только work_sheets.edit (решение владельца 15.09.2026)', () => {
    expect(repairHistoryWritePermissions('sheet')).toEqual([PermissionCode.WorkSheetsEdit]);
    expect(canWriteRepairHistory({ [PermissionCode.OperationsEdit]: true }, 'sheet')).toBe(false);
    expect(canWriteRepairHistory({ [PermissionCode.WorkSheetsEdit]: true }, 'sheet')).toBe(true);
  });

  it('без прав не пишет никто', () => {
    expect(canWriteRepairHistory({}, 'manual')).toBe(false);
    expect(canWriteRepairHistory({}, 'stage')).toBe(false);
    expect(canWriteRepairHistory(null, 'stage')).toBe(false);
  });
});

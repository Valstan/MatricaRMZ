import { describe, expect, it } from 'vitest';

import {
  type DirectoryEmployee,
  type ExistingCard,
  type MirrorOp,
  personnelKey,
  planEmployeeMirror,
} from './ppeEmployeeMirror.js';

// Планировщик зеркала «справочник сотрудников → строгие карточки СИЗ». Держим здесь
// решения, которые на живых данных дороги: матчинг по табельному (00675 = 675),
// идемпотентность (иначе тик каждые 5 минут плодил бы журнальные строки), гашение
// уволенных и отказ от дублей, на которых падает unique-индекс.

const emp = (over: Partial<DirectoryEmployee> = {}): DirectoryEmployee => ({
  entityId: '11111111-1111-1111-1111-111111111111',
  fullName: 'Иванов Иван Иванович',
  personnelNo: '827',
  roleCode: 'слесарь',
  isActive: true,
  ...over,
});

const card = (over: Partial<ExistingCard> = {}): ExistingCard => ({
  id: 'c-1',
  entityId: null,
  personnelNo: null,
  fullName: 'Иванов Иван Иванович',
  roleCode: 'слесарь',
  isActive: true,
  deleted: false,
  ...over,
});

const kinds = (ops: MirrorOp[]) => ops.map((op) => op.kind);

describe('planEmployeeMirror', () => {
  it('пустая таблица карточек → заводит строку с id сущности', () => {
    const employee = emp();
    const plan = planEmployeeMirror([employee], []);
    expect(kinds(plan.ops)).toEqual(['create']);
    const op = plan.ops[0] as Extract<MirrorOp, { kind: 'create' }>;
    expect(op.id).toBe(employee.entityId);
    expect(op.row.personnelNo).toBe('827');
    expect(plan.ambiguous).toEqual([]);
  });

  it('сводит с карточкой импорта по табельному, снимая ведущие нули', () => {
    const employee = emp({ personnelNo: '00675' });
    const existing = card({ id: 'imported', personnelNo: '675' });
    const plan = planEmployeeMirror([employee], [existing]);
    expect(kinds(plan.ops)).toEqual(['update']);
    const op = plan.ops[0] as Extract<MirrorOp, { kind: 'update' }>;
    expect(op.id).toBe('imported');
    expect(op.patch.entityId).toBe(employee.entityId);
    // Табельный импорта не переписываем: строка уже верна по существу.
    expect(op.patch.personnelNo).toBeUndefined();
  });

  it('идемпотентен: сведённая карточка больше не даёт операций', () => {
    const employee = emp();
    const synced = card({ id: employee.entityId, entityId: employee.entityId, personnelNo: '827' });
    const plan = planEmployeeMirror([employee], [synced]);
    expect(plan.ops).toEqual([]);
  });

  it('уволенный сотрудник остаётся карточкой, но гаснет is_active', () => {
    const employee = emp({ isActive: false });
    const synced = card({ id: employee.entityId, entityId: employee.entityId, personnelNo: '827' });
    const plan = planEmployeeMirror([employee], [synced]);
    const op = plan.ops[0] as Extract<MirrorOp, { kind: 'update' }>;
    expect(op.patch.isActive).toBe(false);
  });

  it('переименование и смена должности доезжают до карточки', () => {
    const employee = emp({ fullName: 'Иванов И. И.', roleCode: 'мастер' });
    const synced = card({ id: employee.entityId, entityId: employee.entityId, personnelNo: '827' });
    const plan = planEmployeeMirror([employee], [synced]);
    const op = plan.ops[0] as Extract<MirrorOp, { kind: 'update' }>;
    expect(op.patch.fullName).toBe('Иванов И. И.');
    expect(op.patch.roleCode).toBe('мастер');
  });

  it('удалённый в справочнике сотрудник гасит карточку (история выдач остаётся)', () => {
    const employee = emp();
    const synced = card({ id: employee.entityId, entityId: employee.entityId, personnelNo: '827' });
    const plan = planEmployeeMirror([employee], [synced], [employee.entityId]);
    expect(kinds(plan.ops)).toEqual(['delete']);
    expect((plan.ops[0] as Extract<MirrorOp, { kind: 'delete' }>).id).toBe(employee.entityId);
  });

  it('повторное гашение уже удалённой карточки — не операция', () => {
    const employee = emp();
    const gone = card({ id: employee.entityId, entityId: employee.entityId, personnelNo: '827', deleted: true });
    const plan = planEmployeeMirror([], [gone], [employee.entityId]);
    expect(plan.ops).toEqual([]);
  });

  it('две карточки с одним табельным — не угадываем, отдаём в отчёт', () => {
    const employee = emp({ personnelNo: '42' });
    const plan = planEmployeeMirror(
      [employee],
      [card({ id: 'a', personnelNo: '42' }), card({ id: 'b', personnelNo: '0042' })],
    );
    expect(plan.ops).toEqual([]);
    expect(plan.ambiguous[0]?.reason).toBe('табельный номер у нескольких карточек');
  });

  it('дубль сотрудника в справочнике не ломает unique-индекс табельного', () => {
    const first = emp({ entityId: 'e-1', personnelNo: '827' });
    const second = emp({ entityId: 'e-2', personnelNo: '827' });
    const plan = planEmployeeMirror([first, second], []);
    expect(kinds(plan.ops)).toEqual(['create']);
    expect(plan.ambiguous[0]?.reason).toBe('табельный номер уже занят другой карточкой');
  });

  it('сотрудник без табельного сводится по единственному однофамильцу без табельного', () => {
    const employee = emp({ personnelNo: null, fullName: 'Петров Пётр Петрович' });
    const imported = card({ id: 'imported', fullName: 'Петров Петр Петрович' });
    const plan = planEmployeeMirror([employee], [imported]);
    const op = plan.ops[0] as Extract<MirrorOp, { kind: 'update' }>;
    expect(op.id).toBe('imported');
    expect(op.patch.entityId).toBe(employee.entityId);
  });

  it('однофамильцы без табельного — не угадываем', () => {
    const employee = emp({ personnelNo: null, fullName: 'Петров Пётр Петрович' });
    const plan = planEmployeeMirror(
      [employee],
      [card({ id: 'a', fullName: 'Петров Петр Петрович' }), card({ id: 'b', fullName: 'Петров Петр Петрович' })],
    );
    expect(plan.ops).toEqual([]);
    expect(plan.ambiguous[0]?.reason).toBe('однофамильцы без табельного');
  });

  it('мягко удалённая карточка того же сотрудника возвращается, а не дублируется', () => {
    const employee = emp();
    const gone = card({ id: 'old', entityId: employee.entityId, personnelNo: '827', deleted: true });
    const plan = planEmployeeMirror([employee], [gone]);
    const op = plan.ops[0] as Extract<MirrorOp, { kind: 'update' }>;
    expect(op.id).toBe('old');
    expect(op.patch.revive).toBe(true);
  });
});

describe('personnelKey', () => {
  it('00675 и 675 — один человек, пустое — пусто', () => {
    expect(personnelKey('00675')).toBe(personnelKey('675'));
    expect(personnelKey(' 827 ')).toBe('827');
    expect(personnelKey('')).toBe('');
    expect(personnelKey(null)).toBe('');
  });
});

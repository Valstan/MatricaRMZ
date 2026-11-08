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

  it('номер удалённой карточки ТОГО ЖЕ сотрудника переходит к живой', () => {
    // Прод 08.11.2026: у «Хапиковой И. С.» три карточки-дубля; номер 818 держала
    // удалённая, живая оставалась без табельного, и зеркало падало на уникальный
    // индекс каждую минуту. Номер переходит от удалённой карточки к живой, но НЕ
    // в том же проходе: удалённая должна уехать в зеркало без номера раньше живой,
    // иначе реплика клиента ловит конфликт уникального индекса.
    const employee = emp({ personnelNo: '818' });
    const dead = card({ id: 'dead-1', personnelNo: '818', deleted: true, fullName: employee.fullName });
    const alive = card({ id: 'alive-1', entityId: employee.entityId, personnelNo: null });
    const plan = planEmployeeMirror([employee], [dead, alive]);
    const updates = plan.ops.filter((o) => o.kind === 'update') as Array<
      Extract<MirrorOp, { kind: 'update' }>
    >;
    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe('dead-1');
    expect(updates[0]?.patch.personnelNo).toBeNull();
    expect(plan.ambiguous[0]?.reason).toBe(
      'табельный номер переходит от удалённой карточки — займём следующим проходом',
    );
  });

  it('следующим проходом номер свободен — живая карточка его занимает', () => {
    const employee = emp({ personnelNo: '818' });
    const dead = card({ id: 'dead-1', personnelNo: null, deleted: true, fullName: employee.fullName });
    const alive = card({ id: 'alive-1', entityId: employee.entityId, personnelNo: null });
    const plan = planEmployeeMirror([employee], [dead, alive]);
    const op = plan.ops[0] as Extract<MirrorOp, { kind: 'update' }>;
    expect(op.id).toBe('alive-1');
    expect(op.patch.personnelNo).toBe('818');
    expect(plan.ambiguous).toEqual([]);
  });

  it('табельный номер уволенного не переиспользуется', () => {
    const employee = emp({ personnelNo: '835' });
    const dead = card({ id: 'dead-1', personnelNo: '835', deleted: true, fullName: 'Ватажников Андрей Александрович' });
    const alive = card({ id: 'alive-1', entityId: employee.entityId, personnelNo: null });
    const plan = planEmployeeMirror([employee], [dead, alive]);
    expect(plan.ops.filter((o) => o.kind === 'update')).toEqual([]);
    expect(plan.ambiguous[0]?.reason).toBe('табельный номер уволенного не переиспользуется');
  });

  it('номер живой карточки, который держит удалённая того же сотрудника, освобождается', () => {
    const employee = emp({ personnelNo: '818' });
    const dead = card({ id: 'dead-1', personnelNo: '818', deleted: true, fullName: employee.fullName });
    const alive = card({ id: 'alive-1', entityId: employee.entityId, personnelNo: '818' });
    const plan = planEmployeeMirror([employee], [dead, alive]);
    const updates = plan.ops.filter((o) => o.kind === 'update') as Array<
      Extract<MirrorOp, { kind: 'update' }>
    >;
    expect(updates.some((o) => o.id === 'dead-1' && o.patch.personnelNo === null)).toBe(true);
  });

  it('карточка без табельного заводится сразу, номер — следующим проходом', () => {
    const employee = emp({ personnelNo: '818' });
    const dead = card({ id: 'dead-1', personnelNo: '818', deleted: true, fullName: employee.fullName });
    const plan = planEmployeeMirror([employee], [dead]);
    const creates = plan.ops.filter((o) => o.kind === 'create') as Array<
      Extract<MirrorOp, { kind: 'create' }>
    >;
    expect(creates).toHaveLength(1);
    expect(creates[0]?.row.personnelNo).toBeNull();
    const updates = plan.ops.filter((o) => o.kind === 'update') as Array<
      Extract<MirrorOp, { kind: 'update' }>
    >;
    expect(updates[0]?.id).toBe('dead-1');
    expect(updates[0]?.patch.personnelNo).toBeNull();
  });

  it('оживление откладывается, пока номер не отпустят удалённая карточка', () => {
    const employee = emp({ personnelNo: '818' });
    const gone = card({ id: 'gone-1', entityId: employee.entityId, personnelNo: '818', deleted: true });
    const dead = card({ id: 'dead-1', personnelNo: '818', deleted: true, fullName: employee.fullName });
    const plan = planEmployeeMirror([employee], [gone, dead]);
    const updates = plan.ops.filter((o) => o.kind === 'update') as Array<
      Extract<MirrorOp, { kind: 'update' }>
    >;
    expect(updates.some((o) => o.id === 'dead-1' && o.patch.personnelNo === null)).toBe(true);
    expect(updates.some((o) => o.patch.revive)).toBe(false);
    expect(plan.ambiguous[0]?.reason).toBe(
      'табельный номер переходит от удалённой карточки — оживим следующим проходом',
    );
  });

  it('номер, занятый живой карточкой импорта, второму сотруднику не отдаётся', () => {
    // Карточка импорта без связи со справочником — тоже «живая»: её табельный
    // номер занять нельзя (иначе две живые строки с одним номером).
    const first = emp({ entityId: 'e-1', personnelNo: '42' });
    const second = emp({ entityId: 'e-2', personnelNo: '42' });
    const imported = card({ id: 'imported', personnelNo: '42' });
    const plan = planEmployeeMirror([first, second], [imported]);
    expect(plan.ambiguous.some((a) => a.entityId === 'e-2')).toBe(true);
    expect(plan.ops.filter((o) => o.kind === 'create')).toEqual([]);
  });

  it('оживление не делается, если номер держит другая ЖИВАЯ карточка', () => {
    const employee = emp({ personnelNo: '818' });
    const gone = card({ id: 'gone-1', entityId: employee.entityId, personnelNo: '818', deleted: true });
    const holder = card({ id: 'holder-1', personnelNo: '818' });
    const plan = planEmployeeMirror([employee], [gone, holder]);
    expect(plan.ops).toEqual([]);
    expect(plan.ambiguous[0]?.reason).toBe('табельный номер уже занят другой карточкой');
  });

  it('номер, назначенный раньше в этом проходе, считается занятым', () => {
    // Два сотрудника справочника с одним табельным: второй — в отчёт, а не в
    // правку, которую отвергнет уникальный индекс.
    const first = emp({ entityId: 'e-1', personnelNo: '900' });
    const second = emp({ entityId: 'e-2', personnelNo: '900' });
    const plan = planEmployeeMirror([first, second], []);
    expect(kinds(plan.ops)).toEqual(['create']);
    expect(plan.ambiguous[0]?.reason).toBe('табельный номер уже занят другой карточкой');
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

  // Прод 07.11.2026: в справочнике ТРИ сотрудника с одинаковым ФИО, у двоих карточек,
  // табельный 818 занят первой. Зеркало писало 818 в вторую карточку — уникальный
  // индекс отвергал правку, и строка падала каждую минуту (69 раз за 2,5 часа).
  it('табельный номер, занятый другой карточкой, в карточку не пишется', () => {
    const employee = emp({ entityId: 'e-1', personnelNo: '818', roleCode: 'мастер' });
    const holder = card({ id: 'holder', personnelNo: '818' });
    const mine = card({ id: 'e-1', entityId: 'e-1', roleCode: null });
    const plan = planEmployeeMirror([employee], [holder, mine]);
    const updates = plan.ops.filter((o) => o.kind === 'update') as Array<
      Extract<MirrorOp, { kind: 'update' }>
    >;
    // Номер не навязываем (уникальный индекс), остальные поля синхронизируются.
    expect(updates.every((o) => o.patch.personnelNo === undefined)).toBe(true);
    expect(updates[0]?.patch.roleCode).toBe('мастер');
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

/**
 * Разрез по подразделению не должен зависеть от подписи.
 *
 * Отчёты «Сотрудники» и «Сводка по нарядам» группируют подытоги по ПОДПИСИ подразделения.
 * Пока подпись фолбэчилась на идентификатор, разрез случайно работал: у двух неизвестных
 * подразделений подписи различались (разные UUID), и строки не сливались. Стоит подставить
 * человеческий текст — и оба схлопываются в одну строку «Итого», то есть подписи чинят ценой
 * неверных чисел. Правильный порядок обратный: группируем по идентификатору, показываем текст.
 *
 * Тест держит обе половины сразу: ни идентификатора в ячейке, ни слияния разных подразделений.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));

import { looksLikeIdentifier } from '@matricarmz/shared';

import { attributeDefs, attributeValues, entities, entityTypes, operations } from '../../../database/schema.js';
import { buildEmployeesRosterReport } from './catalogs.js';
import { buildWorkOrderPayrollSummaryReport } from './workOrders.js';

const T0 = Date.UTC(2026, 4, 12);

const EMP_A = 'ee550000-0000-4000-8000-00000000000a';
const EMP_B = 'ee550000-0000-4000-8000-00000000000b';
const EMP_C = 'ee550000-0000-4000-8000-00000000000c';
/** Подразделения, которых нет в справочнике: карточки удалены либо не доехали синхронизацией. */
const DEPT_GONE_1 = 'c3990000-0000-4000-8000-000000000f01';
const DEPT_GONE_2 = 'c3990000-0000-4000-8000-000000000f02';
/** Цеха: канон живёт в `directory_workshops`, в EAV-снимке их карточек нет вовсе. */
const WORKSHOP_1 = 'a7770000-0000-4000-8000-000000000c01';
const WORKSHOP_2 = 'a7770000-0000-4000-8000-000000000c02';

type Row = Record<string, unknown>;

function stubDb(attrsOverride?: Record<string, Record<string, unknown>>): any {
  const types: Row[] = [
    { id: 'T_employee', code: 'employee' },
    { id: 'T_department', code: 'department' },
  ];
  const ents: Row[] = [
    { id: EMP_A, typeId: 'T_employee' },
    { id: EMP_B, typeId: 'T_employee' },
    { id: EMP_C, typeId: 'T_employee' },
  ];
  const attrs: Record<string, Record<string, unknown>> = attrsOverride ?? {
    [EMP_A]: { full_name: 'Иванов Иван', login: 'ivanov', department_id: DEPT_GONE_1 },
    [EMP_B]: { full_name: 'Петров Пётр', login: 'petrov', department_id: DEPT_GONE_2 },
    // Третий вовсе без подразделения — такие обязаны собираться в одну строку.
    [EMP_C]: { full_name: 'Сидоров Сидор', login: 'sidorov' },
  };
  const defs = new Set<string>();
  for (const map of Object.values(attrs)) for (const code of Object.keys(map)) defs.add(code);
  const defRows: Row[] = [...defs].map((code) => ({ id: `D_${code}`, code }));
  const valueRows: Row[] = [];
  for (const [entityId, map] of Object.entries(attrs)) {
    for (const [code, value] of Object.entries(map)) {
      valueRows.push({ entityId, attributeDefId: `D_${code}`, valueJson: JSON.stringify(value) });
    }
  }
  const workOrder = (id: string, employeeId: string, employeeName: string): Row => ({
    id,
    engineEntityId: 'bb220000-0000-4000-8000-000000000001',
    operationType: 'work_order',
    status: 'done',
    performedAt: T0,
    performedBy: 'ivanov',
    createdAt: T0,
    updatedAt: T0,
    metaJson: JSON.stringify({
      kind: 'work_order',
      workOrderNumber: 41,
      orderDate: T0,
      totalAmountRub: 1000,
      workGroups: [{ partName: 'Коленвал', lines: [{ serviceName: 'Шлифовка', qty: 1, amountRub: 1000 }] }],
      crew: [{ employeeId, employeeName, ktu: 1, payoutRub: 1000 }],
    }),
  });
  const byTable = new Map<unknown, Row[]>([
    [entityTypes, types],
    [entities, ents],
    [attributeDefs, defRows],
    [attributeValues, valueRows],
    [operations, [workOrder('op-a', EMP_A, 'Иванов Иван'), workOrder('op-b', EMP_B, 'Петров Пётр')]],
  ]);
  return {
    select() {
      return {
        from(table: unknown) {
          const rows = byTable.get(table) ?? [];
          const chain: any = new Proxy(
            {},
            {
              get(_t, prop) {
                if (prop === 'then') return (resolve: (v: Row[]) => unknown) => resolve(rows);
                return () => chain;
              },
            },
          );
          return chain;
        },
      };
    },
  };
}

describe('«Сотрудники»: разрез по подразделению', () => {
  it('два неизвестных подразделения остаются двумя строками подытогов', async () => {
    const report = await buildEmployeesRosterReport(stubDb(), undefined);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    // Иванов и Петров числятся в РАЗНЫХ подразделениях — слить их в одну строку нельзя,
    // сколько бы одинаково ни выглядели подписи.
    const groups = report.totalsByGroup ?? [];
    expect(groups.filter((g) => g.totals.employees === 1)).toHaveLength(3);
    expect(groups).toHaveLength(3); // два неизвестных + один без подразделения
  });

  it('в колонке «Подразделение» нет идентификаторов', async () => {
    const report = await buildEmployeesRosterReport(stubDb(), undefined);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    for (const row of report.rows) {
      expect(looksLikeIdentifier(String(row.departmentName ?? ''))).toBe(false);
    }
    for (const group of report.totalsByGroup ?? []) {
      expect(looksLikeIdentifier(group.group)).toBe(false);
    }
  });
});

describe('«Сводка по нарядам»: разрез по подразделению', () => {
  it('два неизвестных подразделения остаются двумя строками подытогов', async () => {
    const report = await buildWorkOrderPayrollSummaryReport(stubDb(), undefined);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(2);
    expect(report.totalsByGroup ?? []).toHaveLength(2);
  });

  it('в колонке «Подразделение» нет идентификаторов', async () => {
    const report = await buildWorkOrderPayrollSummaryReport(stubDb(), undefined);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    for (const row of report.rows) {
      expect(looksLikeIdentifier(String(row.departmentName ?? ''))).toBe(false);
    }
    for (const group of report.totalsByGroup ?? []) {
      expect(looksLikeIdentifier(group.group)).toBe(false);
    }
  });
});

/**
 * Оргединица сотрудника — цех, а не только подразделение.
 *
 * Цеха переехали в `directory_workshops` (SSOT), у цеховых рабочих заполнен `workshop_id`,
 * а `department_id` остался у офисных. Пока свод читал только `department_id`, разрез
 * «Цех / подразделение» сваливал всех цеховых в одну строку «(не указано)» — на проде это
 * 264 человека из 408, при том что соседний отчёт «Структура предприятия» те же цеха
 * показывает. Тест держит разрез: цех участвует, разные цеха не сливаются, канон побеждает.
 */
describe('«Сводка по нарядам»: цех участвует в разрезе', () => {
  const byWorkshop = {
    [EMP_A]: { full_name: 'Иванов Иван', login: 'ivanov', workshop_id: WORKSHOP_1 },
    [EMP_B]: { full_name: 'Петров Пётр', login: 'petrov', workshop_id: WORKSHOP_2 },
    [EMP_C]: { full_name: 'Сидоров Сидор', login: 'sidorov' },
  };

  it('два разных цеха остаются двумя строками подытогов, а не одной «(не указано)»', async () => {
    const report = await buildWorkOrderPayrollSummaryReport(stubDb(byWorkshop), undefined);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(2);
    const groups = report.totalsByGroup ?? [];
    expect(groups).toHaveLength(2);
    expect(groups.some((g) => g.group === '(не указано)')).toBe(false);
  });

  it('в подписи цеха нет идентификатора даже без справочника цехов под рукой', async () => {
    // ctx не передан → getWorkshops вернёт пусто: подписи неизвестны, но разрез обязан
    // остаться верным, а UUID в ячейку попасть не должен.
    const report = await buildWorkOrderPayrollSummaryReport(stubDb(byWorkshop), undefined);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    for (const row of report.rows) {
      expect(looksLikeIdentifier(String(row.departmentName ?? ''))).toBe(false);
    }
    for (const group of report.totalsByGroup ?? []) {
      expect(looksLikeIdentifier(group.group)).toBe(false);
    }
  });

  it('при обоих заполненных полях разрез идёт по цеху — он канон', async () => {
    const both = {
      [EMP_A]: { full_name: 'Иванов Иван', login: 'ivanov', workshop_id: WORKSHOP_1, department_id: DEPT_GONE_1 },
      [EMP_B]: { full_name: 'Петров Пётр', login: 'petrov', workshop_id: WORKSHOP_1, department_id: DEPT_GONE_2 },
    };
    const report = await buildWorkOrderPayrollSummaryReport(stubDb(both), undefined);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    // Один цех на двоих → один подытог, хотя подразделения у них разные.
    expect(report.totalsByGroup ?? []).toHaveLength(1);
    expect(report.rows).toHaveLength(2);
  });
});

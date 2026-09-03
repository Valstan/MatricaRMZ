/**
 * Отчёт не показывает нарядов, которых не показывает вкладка «Наряды».
 *
 * Политика `restricted_work_orders` (владелец видит только свои, назначенный читатель —
 * все, остальные не видят чужих закрытых) применялась в `workOrderService.listWorkOrders`
 * и НЕ применялась ни в одном пресете отчётов. Право `reports.view` есть у всех
 * операторских ролей, поэтому «Отчёты → Наряды» печатали то, что список тому же человеку
 * скрывает: номер, двигатель, работы, суммы. На проде это 71 наряд из 145 живых при двух
 * ограниченных владельцах и 22 аккаунтах с доступом к разделу «Отчёты».
 *
 * Сторож держит четыре пресета сразу и главное — направление отказа: актора нет →
 * закрытые наряды НЕ печатаются. Fail-open здесь стоит утечки, fail-closed — пустой
 * строки в отчёте.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));

// Как политика попадает в реплику — предмет employeeSectionGate.replica.test.ts.
// Здесь проверяется, что пресеты её СПРАШИВАЮТ и ПРИМЕНЯЮТ.
vi.mock('../../employeeService.js', () => ({
  getRestrictedWorkOrderPolicyLocal: vi.fn(async () => ({
    owners: new Set(['owner1']),
    readers: new Set(['buh']),
  })),
}));

import { attributeDefs, attributeValues, entities, entityTypes, operations } from '../../../database/schema.js';
import {
  buildWorkOrderCostsReport,
  buildWorkOrdersReport,
  buildWorkOrderPayrollReport,
  buildWorkOrderPayrollSummaryReport,
} from './workOrders.js';

const T0 = Date.UTC(2026, 7, 12);
const PERIOD = { startMs: Date.UTC(2026, 6, 1), endMs: Date.UTC(2026, 8, 30) };

const EMP_OWNER = 'ee550000-0000-4000-8000-0000000000a1';
const EMP_PLAIN = 'ee550000-0000-4000-8000-0000000000a2';

type Row = Record<string, unknown>;

/** Два наряда: один выписан ограниченным владельцем, второй — обычным оператором. */
function stubDb(): any {
  const types: Row[] = [{ id: 'T_employee', code: 'employee' }];
  const ents: Row[] = [
    { id: EMP_OWNER, typeId: 'T_employee' },
    { id: EMP_PLAIN, typeId: 'T_employee' },
  ];
  const attrs: Record<string, Record<string, unknown>> = {
    [EMP_OWNER]: { full_name: 'Владелец Закрытых', login: 'owner1', personnel_number: '101' },
    [EMP_PLAIN]: { full_name: 'Оператор Обычный', login: 'oper', personnel_number: '102' },
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
  const workOrder = (id: string, ownerLogin: string, number: number, employeeId: string, employeeName: string): Row => ({
    id,
    engineEntityId: 'bb220000-0000-4000-8000-000000000001',
    operationType: 'work_order',
    status: 'done',
    performedAt: T0,
    performedBy: ownerLogin,
    createdAt: T0,
    updatedAt: T0,
    metaJson: JSON.stringify({
      kind: 'work_order',
      workOrderNumber: number,
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
    [
      operations,
      [
        workOrder('op-restricted', 'owner1', 777, EMP_OWNER, 'Владелец Закрытых'),
        workOrder('op-plain', 'oper', 555, EMP_PLAIN, 'Оператор Обычный'),
      ],
    ],
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

const viewers = {
  plain: { login: 'oper', role: 'employee' },
  owner: { login: 'owner1', role: 'employee' },
  reader: { login: 'buh', role: 'admin' },
  superadmin: { login: 'boss', role: 'superadmin' },
};

/** Все четыре пресета, печатающие наряды, — одним списком: новый пресет обязан войти сюда. */
const BUILDERS: Array<{ name: string; build: (db: any, ctx: any) => Promise<any> }> = [
  { name: 'work_orders_report', build: (db, ctx) => buildWorkOrdersReport(db, { ...PERIOD }, ctx) },
  { name: 'work_order_costs', build: (db, ctx) => buildWorkOrderCostsReport(db, { ...PERIOD }, ctx) },
  { name: 'work_order_payroll', build: (db, ctx) => buildWorkOrderPayrollReport(db, { ...PERIOD }, ctx) },
  { name: 'work_order_payroll_summary', build: (db, ctx) => buildWorkOrderPayrollSummaryReport(db, { ...PERIOD }, ctx) },
];

/** Ищем след закрытого наряда в любой ячейке: номер, ФИО владельца, его табельный. */
function mentionsRestricted(report: any): boolean {
  if (!report?.ok) return false;
  const haystack = JSON.stringify(report.rows ?? []) + JSON.stringify(report.totalsByGroup ?? []);
  return haystack.includes('777') || haystack.includes('Владелец Закрытых') || haystack.includes('101');
}

/** Форма строк у пресетов разная (наряд, сотрудник, свод), поэтому считаем строки. */
function rowCount(report: any): number {
  return report?.ok ? (report.rows ?? []).length : -1;
}

describe('пресеты нарядов держат политику закрытых нарядов', () => {
  for (const preset of BUILDERS) {
    it(`${preset.name}: обычный оператор не видит наряд ограниченного владельца`, async () => {
      const report = await preset.build(stubDb(), { viewer: viewers.plain });
      expect(report.ok).toBe(true);
      expect(mentionsRestricted(report)).toBe(false);
      // И при этом отчёт не пуст: наряд самого оператора на месте — фильтр режет
      // закрытые, а не всё подряд (иначе сторож был бы зелен на пустом отчёте).
      expect(rowCount(report)).toBeGreaterThan(0);
    });

    it(`${preset.name}: без актора закрытый наряд тоже не печатается (fail-closed)`, async () => {
      const report = await preset.build(stubDb(), undefined);
      expect(report.ok).toBe(true);
      expect(mentionsRestricted(report)).toBe(false);
    });

    it(`${preset.name}: сам владелец, назначенный читатель и суперадмин видят наряд`, async () => {
      for (const viewer of [viewers.owner, viewers.reader, viewers.superadmin]) {
        const report = await preset.build(stubDb(), { viewer });
        expect(report.ok).toBe(true);
        expect(mentionsRestricted(report)).toBe(true);
      }
    });

    it(`${preset.name}: читателю видно строго больше, чем обычному оператору`, async () => {
      // Обычный видит один наряд, назначенный читатель — оба: если бы фильтр не
      // различал людей, эти два числа совпали бы при любом его направлении.
      const plain = await preset.build(stubDb(), { viewer: viewers.plain });
      const reader = await preset.build(stubDb(), { viewer: viewers.reader });
      expect(rowCount(reader)).toBeGreaterThan(rowCount(plain));
    });
  }
});

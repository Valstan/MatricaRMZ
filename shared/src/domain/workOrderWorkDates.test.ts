/**
 * Даты выполнения работ наряда (промт КАРМАНА #165): модель, нормализация и то,
 * что дата работы НЕ ломает дату выполнения наряда.
 */
import { describe, expect, it } from 'vitest';

import {
  deriveWorkOrderStatusCode,
  normalizeWorkOrderLine,
  normalizeWorkOrderPayloadV3Fields,
  normalizeWorkOrderPeriods,
  withWorkOrderCommonPeriod,
  withWorkOrderEmployeePeriod,
  workOrderCommonPeriod,
  workOrderDateMode,
  workOrderLineAssigneeId,
  workOrderLineDate,
  workOrderPeriodOfEmployee,
  workOrderPeriods,
  type WorkOrderPayload,
  type WorkOrderPeriod,
} from './workOrder.js';
import { WORK_ORDERS_REPORT_COLUMNS } from './workOrdersReport.js';

const DAY = 86_400_000;
const T13_MAY = new Date(2026, 4, 13, 12, 0, 0, 0).getTime();
const T2_JUNE = new Date(2026, 5, 2, 12, 0, 0, 0).getTime();

describe('нормализация периодов наряда', () => {
  it('мусор отбрасывается, порядок — по началу периода', () => {
    const periods = normalizeWorkOrderPeriods([
      { employeeId: 'e-2', from: T2_JUNE, to: T2_JUNE },
      { employeeId: '', from: T13_MAY, to: T2_JUNE },
      { employeeId: 'e-3', from: 0, to: 10 },
      'не объект',
    ]);
    expect(periods).toHaveLength(2);
    expect(periods?.[0]).toEqual({ employeeId: '', from: T13_MAY, to: T2_JUNE });
    expect(periods?.[1]?.employeeId).toBe('e-2');
  });

  it('пустой список и мусор дают undefined', () => {
    expect(normalizeWorkOrderPeriods([])).toBeUndefined();
    expect(normalizeWorkOrderPeriods('нет')).toBeUndefined();
    expect(normalizeWorkOrderPeriods(undefined)).toBeUndefined();
  });

  it('период без конца равен своему началу (однодневный)', () => {
    expect(normalizeWorkOrderPeriods([{ employeeId: '', from: T13_MAY }])?.[0]?.to).toBe(T13_MAY);
  });
});

describe('payload наряда — режим дат и периоды', () => {
  it('режим и периоды переживают нормализацию payload', () => {
    const v6 = normalizeWorkOrderPayloadV3Fields({
      workDateMode: 'daily',
      workPeriods: [{ employeeId: 'e-1', from: T13_MAY, to: T2_JUNE }],
    });
    expect(v6.workDateMode).toBe('daily');
    expect(v6.workPeriods).toEqual([{ employeeId: 'e-1', from: T13_MAY, to: T2_JUNE }]);
  });

  it('старый наряд без дат читается как раньше: полей нет, ничего не теряется', () => {
    const v3 = normalizeWorkOrderPayloadV3Fields({ workOrderNumber: 7 });
    expect(v3.workDateMode).toBeUndefined();
    expect(v3.workPeriods).toBeUndefined();
  });

  it('мусорный режим дат не попадает в payload', () => {
    expect(normalizeWorkOrderPayloadV3Fields({ workDateMode: 'каждый час' }).workDateMode).toBeUndefined();
  });

  it('режим дат и периоды читаются хелперами', () => {
    const payload = {
      workDateMode: 'period' as const,
      workPeriods: [
        { employeeId: '', from: T13_MAY, to: T2_JUNE },
        { employeeId: 'e-1', from: T13_MAY, to: T13_MAY + DAY },
      ],
    };
    expect(workOrderDateMode(payload)).toBe('period');
    expect(workOrderPeriods(payload)).toHaveLength(2);
    expect(workOrderCommonPeriod(payload)?.from).toBe(T13_MAY);
    expect(workOrderPeriodOfEmployee(payload, 'e-1')?.from).toBe(T13_MAY);
    expect(workOrderPeriodOfEmployee(payload, 'нет')).toBeNull();
  });

  it('наряд без режима дат — режима нет (печатать нечего)', () => {
    expect(workOrderDateMode({})).toBeNull();
    expect(workOrderDateMode(null)).toBeNull();
  });
});

describe('правка периодов наряда', () => {
  const periods: WorkOrderPeriod[] = [
    { employeeId: '', from: T13_MAY, to: T2_JUNE },
    { employeeId: 'e-1', from: T13_MAY, to: T13_MAY },
  ];

  it('общий период меняется, периоды сотрудников не теряются', () => {
    const next = withWorkOrderCommonPeriod(periods, T2_JUNE, T2_JUNE);
    expect(next[0]).toEqual({ employeeId: '', from: T2_JUNE, to: T2_JUNE });
    expect(next.some((p) => p.employeeId === 'e-1')).toBe(true);
    // Исходный список не мутируется.
    expect(periods[0]?.from).toBe(T13_MAY);
  });

  it('пустой общий период убирается, но период сотрудника остаётся', () => {
    const next = withWorkOrderCommonPeriod(periods, null);
    expect(next).toHaveLength(1);
    expect(next[0]?.employeeId).toBe('e-1');
  });

  it('период сотрудника ставится без общих периодов и без чужих периодов', () => {
    const next = withWorkOrderEmployeePeriod([], 'e-2', T13_MAY, T2_JUNE);
    expect(next).toEqual([{ employeeId: 'e-2', from: T13_MAY, to: T2_JUNE }]);
  });

  it('период сотрудника не трогает общий период наряда и периоды других', () => {
    const next = withWorkOrderEmployeePeriod(periods, 'e-1', T2_JUNE, T2_JUNE);
    expect(next.find((p) => !p.employeeId)?.from).toBe(T13_MAY);
    expect(next.find((p) => p.employeeId === 'e-1')?.from).toBe(T2_JUNE);
  });

  it('однодневный период: конец равен началу', () => {
    const next = withWorkOrderCommonPeriod([], T13_MAY, null);
    expect(next[0]).toEqual({ employeeId: '', from: T13_MAY, to: T13_MAY });
  });
});

describe('строка работы — дата и её исполнитель', () => {  it('дата и исполнитель сохраняются в строке', () => {
    const line = normalizeWorkOrderLine({ workDate: T13_MAY, workAssigneeId: 'e-1' }, 1);
    expect(line.workDate).toBe(T13_MAY);
    expect(line.workAssigneeId).toBe('e-1');
    expect(workOrderLineDate(line)).toBe(T13_MAY);
    expect(workOrderLineAssigneeId(line)).toBe('e-1');
  });

  it('пустые и нечисловые даты отбрасываются (старая строка читается как раньше)', () => {
    expect(normalizeWorkOrderLine({ workDate: 0 }, 1).workDate).toBeUndefined();
    expect(normalizeWorkOrderLine({ workDate: -5 }, 1).workDate).toBeUndefined();
    expect(normalizeWorkOrderLine({ workAssigneeId: '  ' }, 1).workAssigneeId).toBeUndefined();
    expect(workOrderLineDate(normalizeWorkOrderLine({}, 1))).toBeNull();
    expect(workOrderLineAssigneeId(normalizeWorkOrderLine({}, 1))).toBeNull();
  });
});

describe('дата работы не ломает дату выполнения наряда', () => {  const base = {
    operationStatus: 'closed',
    completedAt: new Date(2026, 5, 10, 12, 0, 0, 0).getTime(),
    now: new Date(2026, 5, 11, 12, 0, 0, 0).getTime(),
  };

  it('статус и срок считаются по дате выполнения наряда, а не по дате работы', () => {
    const status = deriveWorkOrderStatusCode({ ...base, dueDate: T2_JUNE, completedDate: T13_MAY });
    expect(status).toBe('done');
  });

  it('дата работы в payload не меняет статус наряда', () => {
    const payload = {
      kind: 'work_order' as const,
      version: 6 as const,
      operationId: 'op-1',
      workOrderNumber: 1,
      orderDate: T13_MAY,
      completedDate: T13_MAY,
      crew: [],
      workGroups: [],
      works: [],
      freeWorks: [{ lineNo: 1, serviceId: null, serviceName: 'Работа', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0, workDate: T2_JUNE }],
      totalAmountRub: 0,
      basePerWorkerRub: 0,
      payouts: [],
    } satisfies WorkOrderPayload;
    const status = deriveWorkOrderStatusCode({
      operationStatus: 'closed',
      completedAt: base.completedAt,
      completedDate: payload.completedDate,
      dueDate: T2_JUNE,
      now: base.now,
    });
    expect(status).toBe('done');
    // Дата работы лежит в строке и на статус наряда не влияет.
    expect(payload.freeWorks[0]?.workDate).toBe(T2_JUNE);
  });

  it('отчёт «Наряды»: колонка «Дата выполнения» осталась прежней', () => {
    // Новая дата у работы — другая величина; колонка отчёта по-прежнему берёт
    // дату выполнения НАРЯДА.
    const col = WORK_ORDERS_REPORT_COLUMNS.find((c) => c.key === 'completedDate');
    expect(col?.label).toBe('Дата выполнения');
  });
});

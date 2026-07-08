import { describe, expect, it } from 'vitest';

import {
  deriveWorkOrderStatusCode,
  isWorkOrderPayloadEmpty,
  normalizeWorkOrderLine,
  normalizeWorkOrderPayloadV3Fields,
  primaryAssemblyEngineId,
  pruneEmptyWorkshopLines,
  WORK_ORDER_KIND_DESCRIPTIONS,
  WORK_ORDER_KIND_LABELS,
  WORK_ORDER_KIND_ORDER,
  WorkOrderKind,
  type WorkOrderPayload,
} from './workOrder.js';

function emptyPayload(overrides: Partial<WorkOrderPayload> = {}): WorkOrderPayload {
  return {
    kind: 'work_order',
    version: 3,
    operationId: 'op-1',
    workOrderNumber: 1,
    orderDate: 0,
    crew: [],
    workGroups: [],
    freeWorks: [],
    works: [],
    totalAmountRub: 0,
    basePerWorkerRub: 0,
    payouts: [],
    ...overrides,
  };
}

describe('normalizeWorkOrderLine', () => {
  it('preserves product number and engine linkage fields', () => {
    const line = normalizeWorkOrderLine(
      {
        serviceId: 'svc-1',
        serviceName: 'Сборка',
        unit: 'шт',
        qty: 2,
        priceRub: 50,
        productNumber: 'Д-42',
        engineId: 'eng-1',
        engineNumber: '12345',
        engineBrandId: 'brand-1',
        engineBrandName: 'М-240',
      },
      1,
    );

    expect(line.productNumber).toBe('Д-42');
    expect(line.engineId).toBe('eng-1');
    expect(line.engineNumber).toBe('12345');
    expect(line.engineBrandId).toBe('brand-1');
    expect(line.engineBrandName).toBe('М-240');
    expect(line.amountRub).toBe(100);
  });

  it('omits empty product number and engine fields', () => {
    const line = normalizeWorkOrderLine(
      {
        serviceName: 'Работа',
        unit: 'шт',
        qty: 1,
        priceRub: 10,
        productNumber: '   ',
        engineId: null,
      },
      2,
    );

    expect(line.productNumber).toBeUndefined();
    expect(line.engineId).toBeUndefined();
    expect(line.engineNumber).toBeUndefined();
    expect(line.partId).toBeUndefined();
    expect(line.partName).toBeUndefined();
  });

  it('preserves part selection fields including article', () => {
    const line = normalizeWorkOrderLine(
      {
        serviceName: 'Сборка',
        unit: 'шт',
        qty: 1,
        priceRub: 100,
        partId: 'part-1',
        partName: 'Гильза 1Ч-12',
        partArticle: 'А-1024',
      },
      3,
    );

    expect(line.partId).toBe('part-1');
    expect(line.partName).toBe('Гильза 1Ч-12');
    expect(line.partArticle).toBe('А-1024');
  });

  it('omits partArticle when empty or partId missing', () => {
    expect(
      normalizeWorkOrderLine({ serviceName: 'Р', unit: 'шт', qty: 1, priceRub: 1, partId: 'p', partArticle: '  ' }, 1)
        .partArticle,
    ).toBeUndefined();
    expect(
      normalizeWorkOrderLine({ serviceName: 'Р', unit: 'шт', qty: 1, priceRub: 1, partId: '', partArticle: 'А-1' }, 1)
        .partArticle,
    ).toBeUndefined();
  });

  it('omits partName when partId is missing', () => {
    const line = normalizeWorkOrderLine(
      {
        serviceName: 'Работа',
        unit: 'шт',
        qty: 1,
        priceRub: 10,
        partId: '',
        partName: 'Лишнее имя',
      },
      4,
    );

    expect(line.partId).toBeUndefined();
    expect(line.partName).toBeUndefined();
  });
});

describe('primaryAssemblyEngineId', () => {
  it('returns first engineId from freeWorks', () => {
    const payload = emptyPayload({
      freeWorks: [
        { lineNo: 1, serviceId: null, serviceName: 'А', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0 },
        { lineNo: 2, serviceId: null, serviceName: 'Б', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0, engineId: 'eng-1' },
        { lineNo: 3, serviceId: null, serviceName: 'В', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0, engineId: 'eng-2' },
      ],
    });
    expect(primaryAssemblyEngineId(payload)).toBe('eng-1');
  });

  it('falls back to workGroups[*].lines[*].engineId when freeWorks has none', () => {
    const payload = emptyPayload({
      freeWorks: [
        { lineNo: 1, serviceId: null, serviceName: 'А', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0 },
      ],
      workGroups: [
        {
          groupId: 'g1',
          partId: 'part-1',
          partName: 'Изделие',
          lines: [
            { lineNo: 1, serviceId: null, serviceName: 'X', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0 },
            { lineNo: 2, serviceId: null, serviceName: 'Y', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0, engineId: 'eng-grp' },
          ],
        },
      ],
    });
    expect(primaryAssemblyEngineId(payload)).toBe('eng-grp');
  });

  it('returns null when no engineId anywhere', () => {
    expect(primaryAssemblyEngineId(emptyPayload())).toBeNull();
  });

  it('ignores whitespace-only engineId', () => {
    const payload = emptyPayload({
      freeWorks: [
        { lineNo: 1, serviceId: null, serviceName: 'А', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0, engineId: '   ' },
        { lineNo: 2, serviceId: null, serviceName: 'Б', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0, engineId: 'eng-real' },
      ],
    });
    expect(primaryAssemblyEngineId(payload)).toBe('eng-real');
  });
});

describe('WorkOrderKind catalog', () => {
  it('keeps WorkshopTemplate in the enum for parsing legacy operations', () => {
    expect(WorkOrderKind.WorkshopTemplate).toBe('workshop_template');
    expect(WORK_ORDER_KIND_LABELS[WorkOrderKind.WorkshopTemplate]).toBe('Ремонт по шаблону цеха');
    expect(WORK_ORDER_KIND_DESCRIPTIONS[WorkOrderKind.WorkshopTemplate]).toMatch(/шаблон/i);
  });

  it('excludes WorkshopTemplate from the picker order (Stage 6: deprecated)', () => {
    expect(WORK_ORDER_KIND_ORDER).not.toContain(WorkOrderKind.WorkshopTemplate);
  });

  it('lists the four base kinds in order exactly once', () => {
    expect(WORK_ORDER_KIND_ORDER.length).toBe(4);
    expect(new Set(WORK_ORDER_KIND_ORDER).size).toBe(4);
    expect(WORK_ORDER_KIND_ORDER[0]).toBe(WorkOrderKind.Regular);
    expect(WORK_ORDER_KIND_ORDER[1]).toBe(WorkOrderKind.Repair);
    expect(WORK_ORDER_KIND_ORDER[2]).toBe(WorkOrderKind.Assembly);
    expect(WORK_ORDER_KIND_ORDER[3]).toBe(WorkOrderKind.Manufacturing);
  });
});

describe('pruneEmptyWorkshopLines', () => {
  function workshopPayload(freeWorks: WorkOrderPayload['freeWorks']): WorkOrderPayload {
    return {
      kind: 'work_order',
      version: 3,
      operationId: 'op-1',
      workOrderNumber: 1,
      orderDate: 0,
      crew: [],
      workGroups: [],
      freeWorks,
      works: [],
      totalAmountRub: 0,
      basePerWorkerRub: 0,
      payouts: [],
      workOrderKind: WorkOrderKind.WorkshopTemplate,
    };
  }

  it('filters out lines with qty <= 0', () => {
    const payload = workshopPayload([
      { lineNo: 1, serviceId: null, serviceName: 'Гильза', unit: 'шт', qty: 0, priceRub: 0, amountRub: 0 },
      { lineNo: 2, serviceId: null, serviceName: 'Поршень', unit: 'шт', qty: 3, priceRub: 0, amountRub: 0 },
      { lineNo: 3, serviceId: null, serviceName: 'Рубашка', unit: 'шт', qty: -1, priceRub: 0, amountRub: 0 },
    ]);
    const result = pruneEmptyWorkshopLines(payload);
    expect(result.freeWorks).toHaveLength(1);
    expect(result.freeWorks[0]?.serviceName).toBe('Поршень');
  });

  it('returns empty freeWorks when every line is empty', () => {
    const payload = workshopPayload([
      { lineNo: 1, serviceId: null, serviceName: 'А', unit: 'шт', qty: 0, priceRub: 0, amountRub: 0 },
      { lineNo: 2, serviceId: null, serviceName: 'Б', unit: 'шт', qty: 0, priceRub: 0, amountRub: 0 },
    ]);
    const result = pruneEmptyWorkshopLines(payload);
    expect(result.freeWorks).toEqual([]);
  });

  it('returns same reference when nothing to prune (no allocation)', () => {
    const payload = workshopPayload([
      { lineNo: 1, serviceId: null, serviceName: 'А', unit: 'шт', qty: 2, priceRub: 0, amountRub: 0 },
      { lineNo: 2, serviceId: null, serviceName: 'Б', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0 },
    ]);
    expect(pruneEmptyWorkshopLines(payload)).toBe(payload);
  });

  it('treats NaN qty as empty', () => {
    const payload = workshopPayload([
      { lineNo: 1, serviceId: null, serviceName: 'A', unit: 'шт', qty: Number.NaN, priceRub: 0, amountRub: 0 },
      { lineNo: 2, serviceId: null, serviceName: 'B', unit: 'шт', qty: 5, priceRub: 0, amountRub: 0 },
    ]);
    const result = pruneEmptyWorkshopLines(payload);
    expect(result.freeWorks).toHaveLength(1);
    expect(result.freeWorks[0]?.serviceName).toBe('B');
  });

  it('does not touch non-Workshop payloads even with empty lines', () => {
    const payload: WorkOrderPayload = {
      ...workshopPayload([
        { lineNo: 1, serviceId: null, serviceName: 'A', unit: 'шт', qty: 0, priceRub: 0, amountRub: 0 },
      ]),
      workOrderKind: WorkOrderKind.Repair,
    };
    expect(pruneEmptyWorkshopLines(payload)).toBe(payload);
  });

  it('does not mutate the original payload', () => {
    const original = workshopPayload([
      { lineNo: 1, serviceId: null, serviceName: 'A', unit: 'шт', qty: 0, priceRub: 0, amountRub: 0 },
      { lineNo: 2, serviceId: null, serviceName: 'B', unit: 'шт', qty: 2, priceRub: 0, amountRub: 0 },
    ]);
    const snapshot = JSON.stringify(original);
    pruneEmptyWorkshopLines(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('normalizeWorkOrderPayloadV3Fields — signatureBlocks', () => {
  it('keeps slots (caption + employeeId) and preserves empty slots for hand-signing', () => {
    const result = normalizeWorkOrderPayloadV3Fields({
      signatureBlocks: [
        { blockId: 'assembly_issued', slots: [{ caption: 'Наряд выдал', employeeId: 'e-1' }, {}, { caption: '  ' }] },
      ],
    });
    expect(result.signatureBlocks).toEqual([
      { blockId: 'assembly_issued', slots: [{ caption: 'Наряд выдал', employeeId: 'e-1' }, {}, {}] },
    ]);
  });

  it('migrates legacy employeeIds to slots', () => {
    const result = normalizeWorkOrderPayloadV3Fields({
      signatureBlocks: [{ blockId: 'assembly_issued', employeeIds: ['e-1', '', 'e-2'] }],
    });
    expect(result.signatureBlocks).toEqual([
      { blockId: 'assembly_issued', slots: [{ employeeId: 'e-1' }, { employeeId: 'e-2' }] },
    ]);
  });

  it('drops blocks with no slots and missing blockId', () => {
    const result = normalizeWorkOrderPayloadV3Fields({
      signatureBlocks: [
        { blockId: 'assembly_issued', slots: [] },
        { blockId: '', slots: [{ employeeId: 'e-1' }] },
      ],
    });
    expect(result.signatureBlocks).toBeUndefined();
  });

  it('omits signatureBlocks when absent', () => {
    expect(normalizeWorkOrderPayloadV3Fields({}).signatureBlocks).toBeUndefined();
  });
});

describe('normalizeWorkOrderPayloadV3Fields — printSettings', () => {
  it('keeps title/date and clamps the per-block fonts to their ranges', () => {
    const r = normalizeWorkOrderPayloadV3Fields({
      printSettings: { titleOverride: '  Мой наряд ', orderDateOverride: 1718312400000, fontDirector: 30, fontTitle: 99, fontMeta: 2, fontCrew: 2, fontWorks: 16, fontSignatures: 13 },
    });
    expect(r.printSettings).toEqual({
      titleOverride: 'Мой наряд',
      orderDateOverride: 1718312400000,
      fontDirector: 20,
      fontTitle: 30,
      fontMeta: 9,
      fontCrew: 9,
      fontWorks: 16,
      fontSignatures: 13,
    });
  });

  it('migrates legacy fontHeader → fontTitle (clamped to title range)', () => {
    expect(normalizeWorkOrderPayloadV3Fields({ printSettings: { fontHeader: 99 } }).printSettings).toEqual({ fontTitle: 30 });
  });

  it('explicit fontTitle wins over legacy fontHeader', () => {
    expect(normalizeWorkOrderPayloadV3Fields({ printSettings: { fontHeader: 14, fontTitle: 26 } }).printSettings).toEqual({ fontTitle: 26 });
  });

  it('omits empty/blank/absent printSettings', () => {
    expect(normalizeWorkOrderPayloadV3Fields({ printSettings: {} }).printSettings).toBeUndefined();
    expect(normalizeWorkOrderPayloadV3Fields({ printSettings: { titleOverride: '   ' } }).printSettings).toBeUndefined();
    expect(normalizeWorkOrderPayloadV3Fields({}).printSettings).toBeUndefined();
  });

  it('keeps approver only for the non-default technical variant', () => {
    expect(normalizeWorkOrderPayloadV3Fields({ printSettings: { approver: 'technical' } }).printSettings).toEqual({ approver: 'technical' });
    // 'director' is the default → omitted (prints director when absent), keeps old naряды byte-identical.
    expect(normalizeWorkOrderPayloadV3Fields({ printSettings: { approver: 'director' } }).printSettings).toBeUndefined();
    expect(normalizeWorkOrderPayloadV3Fields({ printSettings: { approver: 'bogus' } }).printSettings).toBeUndefined();
  });

  it('round-trips startDate/dueDate (positive ms only)', () => {
    expect(normalizeWorkOrderPayloadV3Fields({ startDate: 111, dueDate: 222 })).toMatchObject({ startDate: 111, dueDate: 222 });
    const none = normalizeWorkOrderPayloadV3Fields({ startDate: 0, dueDate: -5 });
    expect(none.startDate).toBeUndefined();
    expect(none.dueDate).toBeUndefined();
  });

  it('round-trips completedDate (positive ms only)', () => {
    expect(normalizeWorkOrderPayloadV3Fields({ completedDate: 333 })).toMatchObject({ completedDate: 333 });
    expect(normalizeWorkOrderPayloadV3Fields({ completedDate: 0 }).completedDate).toBeUndefined();
    expect(normalizeWorkOrderPayloadV3Fields({ completedDate: -1 }).completedDate).toBeUndefined();
    expect(normalizeWorkOrderPayloadV3Fields({}).completedDate).toBeUndefined();
  });
});

describe('isWorkOrderPayloadEmpty', () => {
  it('treats a freshly-created payload (no lines/crew/groups) as empty', () => {
    expect(isWorkOrderPayloadEmpty(emptyPayload())).toBe(true);
    expect(isWorkOrderPayloadEmpty(null)).toBe(true);
    expect(isWorkOrderPayloadEmpty(undefined)).toBe(true);
    expect(isWorkOrderPayloadEmpty({})).toBe(true);
  });

  it('treats any content (work line, crew, linked doc) as non-empty', () => {
    expect(isWorkOrderPayloadEmpty(emptyPayload({ freeWorks: [{ lineNo: 1 } as never] }))).toBe(false);
    expect(isWorkOrderPayloadEmpty(emptyPayload({ crew: [{ employeeId: 'e1' } as never] }))).toBe(false);
    expect(isWorkOrderPayloadEmpty({ linkedDocumentId: 'doc-1' })).toBe(false);
  });
});

describe('deriveWorkOrderStatusCode', () => {
  const DAY = 86_400_000;
  const due = 1_700_000_000_000; // fixed due ms; expiry = due + DAY

  it('open without due → issued', () => {
    expect(deriveWorkOrderStatusCode({ operationStatus: 'open', now: due })).toBe('issued');
  });
  it('open, due day not yet passed → issued', () => {
    expect(deriveWorkOrderStatusCode({ operationStatus: 'open', dueDate: due, now: due + DAY - 1 })).toBe('issued');
  });
  it('open, due day passed → overdue', () => {
    expect(deriveWorkOrderStatusCode({ operationStatus: 'open', dueDate: due, now: due + DAY })).toBe('overdue');
  });
  it('closed in time → done', () => {
    expect(deriveWorkOrderStatusCode({ operationStatus: 'closed', dueDate: due, completedAt: due, now: due + 10 * DAY })).toBe('done');
  });
  it('closed without due → done', () => {
    expect(deriveWorkOrderStatusCode({ operationStatus: 'closed', completedAt: due, now: due })).toBe('done');
  });
  it('closed after the due day → done_late', () => {
    expect(deriveWorkOrderStatusCode({ operationStatus: 'closed', dueDate: due, completedAt: due + DAY, now: due + 10 * DAY })).toBe('done_late');
  });

  // Оператор проставил фактическую дату выполнения на НЕзакрытом наряде — она приоритетна над
  // «просрочкой по сроку» (регресс: розовым красило даже с датой выполнения в срок).
  it('open, completedDate in time (past due day) → done, not overdue', () => {
    expect(
      deriveWorkOrderStatusCode({ operationStatus: 'open', dueDate: due, completedDate: due, now: due + 10 * DAY }),
    ).toBe('done');
  });
  it('open, completedDate after the due day → done_late, not overdue', () => {
    expect(
      deriveWorkOrderStatusCode({ operationStatus: 'open', dueDate: due, completedDate: due + DAY, now: due + 10 * DAY }),
    ).toBe('done_late');
  });
  it('open, no completedDate, due day passed → overdue (unchanged)', () => {
    expect(deriveWorkOrderStatusCode({ operationStatus: 'open', dueDate: due, now: due + DAY })).toBe('overdue');
  });
  it('closed completedDate overrides close time for done_late', () => {
    // операция закрыта поздно (completedAt late), но оператор указал дату выполнения в срок → done
    expect(
      deriveWorkOrderStatusCode({
        operationStatus: 'closed',
        dueDate: due,
        completedAt: due + 5 * DAY,
        completedDate: due,
        now: due + 10 * DAY,
      }),
    ).toBe('done');
  });
});

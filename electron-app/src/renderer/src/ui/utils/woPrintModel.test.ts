import { describe, expect, it } from 'vitest';

import { WorkOrderKind, type WorkOrderPayload, type WorkOrderWorkLine } from '@matricarmz/shared';

import { buildWorkOrderPrintModel, type WoPrintDeps } from './woPrintModel.js';

const DEPS: WoPrintDeps = {
  employees: [
    { id: 'e-1', displayName: 'Иванов И.И.', lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович', position: 'Слесарь', workshopId: 'w-1', personnelNumber: '1043' },
    { id: 'e-2', displayName: 'Петров П.П.', lastName: 'Петров', firstName: 'Пётр', middleName: 'Петрович', position: 'Слесарь', workshopId: 'w-1' },
  ],
  engines: [{ id: 'eng-1', engineNumber: '12345', engineBrandName: 'В-84', engineInternalNumber: '41/26' }],
  parts: [{ id: 'p-1', name: 'Поршень', article: 'ART-77' }],
  workshops: [{ id: 'w-1', name: 'Цех 1' }],
  warehouseLocations: [{ id: 'wh-1', code: 'MAIN', name: 'Главный склад' }],
  engineContractInfo: { 'eng-1': { contractSuffix: '*239', counterparty: 'МО РФ' } },
  hiddenFields: new Set<string>(),
};

function line(over: Partial<WorkOrderWorkLine> = {}): WorkOrderWorkLine {
  return {
    lineNo: 1,
    serviceId: null,
    serviceName: 'Расточка',
    unit: 'шт',
    qty: 2,
    priceRub: 100,
    amountRub: 200,
    partId: 'p-1',
    partName: 'Поршень',
    engineId: 'eng-1',
    engineNumber: '12345',
    engineBrandName: 'В-84',
    ...over,
  };
}

function payload(over: Partial<WorkOrderPayload> = {}): WorkOrderPayload {
  return {
    version: 4,
    workOrderNumber: 101,
    orderDate: Date.UTC(2026, 6, 14),
    crew: [{ employeeId: 'e-1', employeeName: 'Иванов И.И.', ktu: 1.2, payoutRub: 500 }],
    workGroups: [],
    works: [],
    freeWorks: [line()],
    payouts: [],
    totalAmountRub: 200,
    workshopId: 'w-1',
    ...over,
  } as unknown as WorkOrderPayload;
}

const sectionIds = (model: { sections: Array<{ id: string }> }) => model.sections.map((s) => s.id);
const html = (model: { sections: Array<{ id: string; html: string }> }, id: string) =>
  model.sections.find((s) => s.id === id)?.html ?? '';

describe('woPrintModel — наряд на сборку', () => {
  const model = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Assembly }), {}, DEPS);

  it('печатает гриф «Утверждаю» и двухфазные подписи', () => {
    expect(sectionIds(model)).toContain('director');
    expect(html(model, 'director')).toContain('Утверждаю');
    expect(html(model, 'signatures')).toContain('Наряд выдал');
    expect(html(model, 'signatures')).toContain('Работу сдал');
  });

  it('в строках склад вместо цены/суммы, а двигатель вынесен в шапку', () => {
    expect(html(model, 'works')).toContain('Склад');
    expect(html(model, 'works')).not.toContain('<th>Цена</th>');
    expect(html(model, 'meta')).toContain('Марка дв.');
    expect(html(model, 'meta')).toContain('12345');
  });

  it('гриф снимается флагом hideApprover', () => {
    const hidden = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Assembly }), { hideApprover: true }, DEPS);
    expect(sectionIds(hidden)).not.toContain('director');
  });
});

describe('woPrintModel — простая форма (обычный / ремонт / изготовление)', () => {
  for (const kind of [WorkOrderKind.Regular, WorkOrderKind.Repair, WorkOrderKind.Manufacturing]) {
    it(`${kind}: без грифа «Утверждаю» и без «сдал/принял»`, () => {
      const model = buildWorkOrderPrintModel(payload({ workOrderKind: kind }), {}, DEPS);
      expect(sectionIds(model)).not.toContain('director');
      const signatures = html(model, 'signatures');
      expect(signatures).not.toContain('Работу сдал');
      expect(signatures).not.toContain('Работу принял');
      expect(signatures).not.toContain('Наряд выдал');
      expect(signatures).toContain('Специалист по нормированию');
      expect(signatures).toContain('Специалист по кадрам');
      expect(signatures).toContain('ОТК');
      expect(signatures).toContain('Мастер цеха');
    });
  }

  it('бригада печатается с КТУ и пустой ячейкой под роспись', () => {
    const model = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair }), {}, DEPS);
    const crew = html(model, 'crew');
    expect(crew).toContain('<th>КТУ</th>');
    expect(crew).toContain('1.2');
    expect(crew).toContain('<th>Подпись</th>');
    expect(crew).toContain('wo-sign-cell');
    expect(model.extraCss).toContain('wo-sign-cell');
  });

  it('бригада: «Фамилия И.О.», следом табельный номер из карточки сотрудника', () => {
    const model = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Repair,
        crew: [
          { employeeId: 'e-1', employeeName: 'Иванов И.И.', ktu: 1.2, payoutRub: 500 },
          // У Петрова табельного нет — в бумаге на его месте пустая ячейка, не «—».
          { employeeId: 'e-2', employeeName: 'Петров П.П.', ktu: 1, payoutRub: 400 },
        ],
      }),
      {},
      DEPS,
    );
    const crew = html(model, 'crew');
    expect(crew).toContain('<th>Таб. №</th>');
    expect(crew).toContain('<td>Иванов И.И.</td><td>1043</td>');
    expect(crew).toContain('<td>Петров П.П.</td><td></td>');
    // Колонка табельного стоит сразу за фамилией, до КТУ.
    expect(crew.indexOf('<th>Таб. №</th>')).toBeLessThan(crew.indexOf('<th>КТУ</th>'));
  });

  it('печатает стоимость услуг и итог', () => {
    const works = html(buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair }), {}, DEPS), 'works');
    expect(works).toContain('<th>Цена</th>');
    expect(works).toContain('<th>Сумма</th>');
    expect(works).toContain('Итог:');
  });

  it('«№ детали» — клеймо из дефектовки, колонка появляется только когда оно есть', () => {
    const without = html(buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair }), {}, DEPS), 'works');
    expect(without).not.toContain('№ детали');

    const withStamp = html(
      buildWorkOrderPrintModel(
        payload({ workOrderKind: WorkOrderKind.Repair, freeWorks: [line({ stampedNumbers: ['А-1201', 'А-1202'] })] }),
        {},
        DEPS,
      ),
      'works',
    );
    expect(withStamp).toContain('№ детали');
    expect(withStamp).toContain('А-1201, А-1202');
  });

  it('один двигатель на наряд уезжает в шапку, несколько — остаются построчно', () => {
    const single = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair }), {}, DEPS);
    expect(html(single, 'meta')).toContain('12345');
    expect(html(single, 'works')).not.toContain('№ двигателя');

    const many = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Repair,
        freeWorks: [line(), line({ lineNo: 2, engineId: 'eng-2', engineNumber: '999', engineBrandName: 'В-59' })],
      }),
      {},
      DEPS,
    );
    expect(html(many, 'works')).toContain('№ двигателя');
    expect(html(many, 'meta')).not.toContain('№ дв.');
  });

  it('уже подписанный старый наряд не теряет свои блоки', () => {
    const model = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Repair,
        signatureBlocks: [{ blockId: 'completion', slots: [{ caption: 'Работу принял', employeeId: 'e-1' }] }],
      }),
      {},
      DEPS,
    );
    const signatures = html(model, 'signatures');
    expect(signatures).toContain('Работу принял');
    expect(signatures).toContain('И.И. Иванов');
  });

  it('скрытые шаблоном поля убирают цену, сумму и вид работ', () => {
    const model = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair }), {}, {
      ...DEPS,
      hiddenFields: new Set(['priceRub', 'amountRub', 'serviceName']),
    });
    const works = html(model, 'works');
    expect(works).not.toContain('<th>Цена</th>');
    expect(works).not.toContain('<th>Сумма</th>');
    expect(works).not.toContain('Вид работ');
    expect(works).not.toContain('Итог:');
    expect(html(model, 'crew')).not.toContain('Начислено');
  });
});

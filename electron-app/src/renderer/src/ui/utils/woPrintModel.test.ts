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

  it('без документного номера шапка называет двигатель номером РМЗ, а не прочерком', () => {
    // Карточка заведена без номера с картера: «№ дв. —» не опознаёт двигатель,
    // а номер РМЗ выдан сервером и живёт в карточке.
    const noDocNumber: WoPrintDeps = {
      ...DEPS,
      engines: [{ id: 'eng-9', engineBrandName: 'В-84', rmzCode: 'RMZ451' }],
    };
    const model = buildWorkOrderPrintModel(
      payload({ workOrderKind: WorkOrderKind.Assembly, freeWorks: [line({ engineId: 'eng-9', engineNumber: '' })] }),
      {},
      noDocNumber,
    );
    expect(html(model, 'meta')).toContain('RMZ451');
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
  it('галочка снимает один блок подписей, остальные печатаются', () => {
    const model = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Repair,
        signatureBlocks: [{ blockId: 'completion', slots: [{ caption: 'Работу принял', employeeId: 'e-1' }] }],
      }),
      { hideSignatureBlocks: ['completion'] },
      DEPS,
    );
    const signatures = html(model, 'signatures');
    expect(signatures).not.toContain('Работу принял');
    expect(signatures).toContain('Специалист по нормированию');
  });

  it('галочка «убрать все подписи» снимает секцию целиком', () => {
    const model = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair }), { hideSignatures: true }, DEPS);
    expect(sectionIds(model)).not.toContain('signatures');
  });

  it('роспись бригады снимается галочкой', () => {
    const model = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair }), { hideCrewSignatures: true }, DEPS);
    const crew = html(model, 'crew');
    expect(crew).not.toContain('<th>Подпись</th>');
    expect(crew).not.toContain('wo-sign-cell');
  });

  it('бригада сборочного наряда тоже получает клетку под роспись', () => {
    const model = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Assembly }), {}, DEPS);
    const crew = html(model, 'crew');
    expect(crew).toContain('<th>Подпись</th>');
    expect(crew).toContain('wo-sign-cell');
    expect(model.extraCss).toContain('td.wo-sign-cell');
  });
});

/* -------------------------------------------------------------------------- *
 * Печать на один лист A4 (промт КАРМАНА #165, шаги 2–3).
 * -------------------------------------------------------------------------- */

describe('woPrintModel — лист A4', () => {
  const model = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair }), {}, DEPS);

  it('поля печати задаёт @page (12мм), а не обнулённые поля страницы', () => {
    // Поля @page обнулённые = содержимое упирается в край бумаги, принтер срезает края.
    expect(model.extraCss).toContain('@page { size: A4; margin: 12mm; }');
    expect(model.extraCss).not.toContain('@page { size: A4; margin: 0; }');
  });

  it('таблицы работ и бригады — фиксированной ширины: колонки не уезжают за край', () => {
    expect(model.extraCss).toContain('table-layout: fixed');
    expect(html(model, 'works')).toContain('<colgroup>');
    expect(html(model, 'crew')).toContain('<colgroup>');
  });

  it('длинные значения переносятся, а не вылезают в соседнюю колонку', () => {
    expect(model.extraCss).toContain('overflow-wrap: anywhere');
  });

  it('у таблиц реквизитов ряды выровнены по общему числу колонок', () => {
    const meta = html(model, 'meta');
    const headCells = (meta.match(/<th>/g) ?? []).length;
    const bodyCells = (meta.match(/<td>/g) ?? []).length;
    expect(headCells).toBe(bodyCells);
  });
});

/* -------------------------------------------------------------------------- *
 * Даты выполнения работ (промт КАРМАНА #165, шаги 4–7).
 * -------------------------------------------------------------------------- */

describe('woPrintModel — даты выполнения работ', () => {
  const day = (m: number, d: number) => new Date(2026, m - 1, d, 12, 0, 0, 0).getTime();

  it('старый наряд без дат печатается как раньше: ни периода, ни колонок дат', () => {
    const model = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair }), {}, DEPS);
    expect(html(model, 'meta')).not.toContain('Период');
    expect(html(model, 'works')).not.toContain('<th>Дата</th>');
    expect(html(model, 'works')).not.toContain('<th>Исполнитель</th>');
  });

  it('режим «период»: печатается «с 13 мая по 2 июня», у отдельных работ дат нет', () => {
    const model = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Repair,
        workDateMode: 'period',
        workPeriods: [{ employeeId: '', from: day(5, 13), to: day(6, 2) }],
        freeWorks: [line({ workDate: day(5, 13), workAssigneeId: 'e-1' })],
      }),
      {},
      DEPS,
    );
    expect(html(model, 'meta')).toContain('Период');
    expect(html(model, 'meta')).toContain('с 13 мая по 2 июня');
    // Дата у работы в режиме «период» на лист не попадает.
    expect(html(model, 'works')).not.toContain('<th>Дата</th>');
  });

  it('режим «ежедневно»: у каждой работы своя дата, рядом видно исполнителя', () => {
    const model = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Repair,
        workDateMode: 'daily',
        crew: [
          { employeeId: 'e-1', employeeName: 'Иванов И.И.', ktu: 1.2, payoutRub: 500 },
          { employeeId: 'e-2', employeeName: 'Петров П.П.', ktu: 1, payoutRub: 400 },
        ],
        freeWorks: [
          line({ workDate: day(5, 13), workAssigneeId: 'e-1' }),
          line({ lineNo: 2, workDate: day(5, 14), workAssigneeId: 'e-2' }),
        ],
      }),
      {},
      DEPS,
    );
    const works = html(model, 'works');
    expect(works).toContain('<th>Дата</th>');
    expect(works).toContain('<th>Исполнитель</th>');
    expect(works).toContain('13 мая');
    expect(works).toContain('14 мая');
    expect(works).toContain('Иванов И.И.');
    expect(works).toContain('Петров П.П.');
  });

  it('смешанный случай: один сотрудник по дням, другой за период — даты не смешиваются', () => {
    const model = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Repair,
        workDateMode: 'daily',
        workPeriods: [{ employeeId: 'e-2', from: day(5, 20), to: day(6, 2) }],
        crew: [
          { employeeId: 'e-1', employeeName: 'Иванов И.И.', ktu: 1.2, payoutRub: 500 },
          { employeeId: 'e-2', employeeName: 'Петров П.П.', ktu: 1, payoutRub: 400 },
        ],
        freeWorks: [
          line({ workDate: day(5, 13), workAssigneeId: 'e-1' }),
          line({ lineNo: 2, workAssigneeId: 'e-2' }),
        ],
      }),
      {},
      DEPS,
    );
    // Период сотрудника — отдельной строкой реквизитов, с именем.
    expect(html(model, 'meta')).toContain('Период · Петров П.П.');
    expect(html(model, 'meta')).toContain('с 20 мая по 2 июня');
    // Дата по дням — только у своего исполнителя.
    const works = html(model, 'works');
    expect(works).toContain('13 мая');
    expect(works).not.toContain('20 мая');
  });

  it('обе формы печатают даты одинаково', () => {
    const shared = {
      workDateMode: 'daily' as const,
      freeWorks: [line({ workDate: day(5, 13), workAssigneeId: 'e-1' })],
    };
    const simple = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Repair, ...shared }), {}, DEPS);
    const assembly = buildWorkOrderPrintModel(payload({ workOrderKind: WorkOrderKind.Assembly, ...shared }), {}, DEPS);
    expect(html(simple, 'works')).toContain('<th>Дата</th>');
    expect(html(assembly, 'works')).toContain('<th>Дата</th>');
    expect(html(simple, 'works')).toContain('13 мая');
    expect(html(assembly, 'works')).toContain('13 мая');
  });

  it('даты работ не трогают дату выполнения наряда', () => {
    // Дата выполнения наряда — в грифе директора (сборочная форма) печатается дата
    // НАРЯДА; дата работы живёт в своей колонке и в гриф не подменяется.
    const assembly = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Assembly,
        completedDate: day(6, 2),
        workDateMode: 'daily',
        freeWorks: [line({ workDate: day(5, 13), workAssigneeId: 'e-1' })],
      }),
      {},
      DEPS,
    );
    expect(html(assembly, 'director')).toContain('14.07.2026');
    expect(html(assembly, 'director')).not.toContain('02.06.2026');
    expect(html(assembly, 'works')).toContain('13 мая');
    // Дата выполнения наряда в таблицу работ не попадает.
    expect(html(assembly, 'works')).not.toContain('02.06.2026');
  });

  it('в режиме «ежедневно» колонка «Дата» есть даже без внесённых дат', () => {
    // Иначе оператор увидит в карточке поле «Дата», а на наряде — нет, и решит,
    // что даты не печатаются вовсе.
    const model = buildWorkOrderPrintModel(
      payload({ workOrderKind: WorkOrderKind.Repair, workDateMode: 'daily', freeWorks: [line()] }),
      {},
      DEPS,
    );
    expect(html(model, 'works')).toContain('<th>Дата</th>');
  });

  it('общий период в режиме «ежедневно» не печатается — у каждой работы своя дата', () => {
    const model = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Repair,
        workDateMode: 'daily',
        workPeriods: [{ employeeId: '', from: day(5, 13), to: day(6, 2) }],
        freeWorks: [line({ workDate: day(5, 13), workAssigneeId: 'e-1' })],
      }),
      {},
      DEPS,
    );
    expect(html(model, 'meta')).not.toContain('Период');
    expect(html(model, 'works')).toContain('13 мая');
  });

  it('выгружаемый файл несёт ту же дату, что и печать: секции одни и те же', () => {
    // Выгрузка в Word собирается из тех же секций модели, что и печать, — расхождение
    // даты в файле и на листе невозможно по построению.
    const model = buildWorkOrderPrintModel(
      payload({
        workOrderKind: WorkOrderKind.Repair,
        workDateMode: 'daily',
        freeWorks: [line({ workDate: day(5, 13), workAssigneeId: 'e-1' })],
      }),
      {},
      DEPS,
    );
    const worksSection = model.sections.find((s) => s.id === 'works');
    expect(worksSection?.html).toContain('13 мая');
    expect(worksSection?.html).toContain('<th>Дата</th>');
  });
});

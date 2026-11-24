import { describe, expect, it } from 'vitest';

import type { EngineListItem } from '../ipc/types.js';
import {
  buildProductionProgramPeriod,
  buildProductionProgramPrintModel,
  findProductionProgramSignatory,
  formatProductionProgramPeriod,
  parseProductionProgramSignatureSlots,
  parseProductionProgramState,
  productionProgramContractLabel,
  productionProgramEngineHint,
  productionProgramEngineStage,
  productionProgramGroupLabel,
  productionProgramOrganizationLabel,
  productionProgramPeriodKind,
  productionProgramRowExecution,
  productionProgramRowFromEngine,
  productionProgramRowHighlight,
  productionProgramStageNeighbours,
  productionProgramStageOptions,
  productionProgramExecutionSummary,
  PRODUCTION_PROGRAM_APPROVER,
  PRODUCTION_PROGRAM_SIGNATURE_SLOTS,
  PRODUCTION_PROGRAM_STATE_LABELS,
  resolveProductionProgramSignatureName,
  resolveProductionProgramSignatureSlots,
  suggestedProductionProgramStates,
} from './productionProgram.js';
import { HUMAN_LABEL_DASH, looksLikeIdentifier } from './humanLabels.js';

function engine(overrides: Partial<EngineListItem> = {}): EngineListItem {
  return {
    id: 'e1',
    arrivalDate: 1_000,
    shippingDate: null,
    statusFlags: {},
    lastStageCode: null,
    lastStageAt: null,
    isScrap: false,
    ...overrides,
  } as EngineListItem;
}

describe('состояния строк производственной программы', () => {
  it('три значения из образца разбираются, чужие — нет', () => {
    expect(parseProductionProgramState('restoration')).toBe('restoration');
    expect(parseProductionProgramState('repairable')).toBe('repairable');
    expect(parseProductionProgramState('capital_repair')).toBe('capital_repair');
    expect(parseProductionProgramState('shipped')).toBeNull();
    expect(parseProductionProgramState('')).toBeNull();
  });

  it('подписи состояний — как в образце', () => {
    expect(PRODUCTION_PROGRAM_STATE_LABELS.restoration).toBe('Восстановление');
    expect(PRODUCTION_PROGRAM_STATE_LABELS.repairable).toBe('Ремонтопригодный');
    expect(PRODUCTION_PROGRAM_STATE_LABELS.capital_repair).toBe('Капитальный ремонт');
  });

  it('подсказка по виду договора: военный — восстановление/ремонт, гражданский — капремонт', () => {
    expect(suggestedProductionProgramStates('military')).toEqual(['restoration', 'repairable']);
    expect(suggestedProductionProgramStates('civil')).toEqual(['capital_repair']);
    expect(suggestedProductionProgramStates(null)).toHaveLength(3);
  });
});

describe('подписи программы', () => {
  it('в образце 7 строк подписи, гриф утверждения отдельный', () => {
    // Заказ владельца 24.11.2026: «убери директора из подписей — оставь его
    // только в разделе Утверждаю». Гриф «УТВЕРЖДАЮ» при этом не тронут.
    expect(PRODUCTION_PROGRAM_SIGNATURE_SLOTS).toHaveLength(7);
    expect(PRODUCTION_PROGRAM_SIGNATURE_SLOTS[0]?.caption).toBe('Коммерческий директор');
    expect(PRODUCTION_PROGRAM_SIGNATURE_SLOTS.at(-1)?.caption).toBe(
      'Начальник отдела по рекламационной работе и работе с ВП',
    );
    // Директора в блоке подписей нет — ни отдельной строкой, ни внутри другой.
    expect(PRODUCTION_PROGRAM_SIGNATURE_SLOTS.map((s) => s.caption)).not.toContain('Директор');
  });

  it('директор остался в грифе «УТВЕРЖДАЮ»', () => {
    expect(PRODUCTION_PROGRAM_APPROVER.title).toBe('УТВЕРЖДАЮ');
    expect(PRODUCTION_PROGRAM_APPROVER.position).toContain('Директор');
    expect(PRODUCTION_PROGRAM_APPROVER.fullName).not.toBe('');
  });

  it('несохранённые слоты достраиваются ФИО из образца', () => {
    const slots = resolveProductionProgramSignatureSlots(null);
    expect(slots).toHaveLength(7);
    expect(slots[0]?.fullName).toBe('Беркута А.А.');
    expect(slots[0]?.employeeId).toBeNull();
  });

  it('мусорный JSON не роняет разбор', () => {
    expect(parseProductionProgramSignatureSlots('{broken')).toEqual([]);
    expect(parseProductionProgramSignatureSlots('[]')).toEqual([]);
    expect(parseProductionProgramSignatureSlots(null)).toEqual([]);
    expect(parseProductionProgramSignatureSlots([{ caption: 'X', employeeId: null, fullName: 'Y' }])).toEqual([
      { caption: 'X', employeeId: null, fullName: 'Y' },
    ]);
  });

  it('привязанный сотрудник печатается из карточки, без привязки — из документа', () => {
    const employees = [
      { id: 'emp-1', fullName: 'Иванов Иван Иванович', position: 'Коммерческий директор', employmentStatus: 'working' },
    ];
    const bound = resolveProductionProgramSignatureName(
      { caption: 'Коммерческий директор', employeeId: 'emp-1', fullName: 'Беркута А.А.' },
      employees,
    );
    expect(bound).toEqual({ name: 'Иванов И.И.', source: 'employee' });

    const unbound = resolveProductionProgramSignatureName(
      { caption: 'Коммерческий директор', employeeId: null, fullName: 'Беркута А.А.' },
      employees,
    );
    expect(unbound).toEqual({ name: 'Беркута А.А.', source: 'document' });
  });

  it('подбор по должности находит сотрудника; директор не достаётся в чужие слоты', () => {
    const employees = [
      { id: 'emp-1', fullName: 'Беркута Алексей Алексеевич', position: 'Коммерческий директор', employmentStatus: 'working' },
      { id: 'emp-2', fullName: 'Тихомиров Иван Анатольевич', position: 'Директор', employmentStatus: 'working' },
    ];
    const commercial = PRODUCTION_PROGRAM_SIGNATURE_SLOTS.find((s) => s.caption === 'Коммерческий директор')!;
    const technical = PRODUCTION_PROGRAM_SIGNATURE_SLOTS.find((s) => s.caption === 'Технический директор')!;
    expect(findProductionProgramSignatory(employees, commercial)?.id).toBe('emp-1');
    // Слота «Директор» больше нет (24.11.2026), и обычный директор не должен
    // занимать чужую строку подписи.
    expect(findProductionProgramSignatory(employees, technical)?.id).not.toBe('emp-2');
  });
});

describe('подсказка по двигателю', () => {
  it('на заводе — можно брать', () => {
    const hint = productionProgramEngineHint(engine());
    expect(hint.tone).toBe('ok');
    expect(hint.text).toContain('можно брать');
  });

  it('ещё не прибыл и утиль — отдельные подсказки', () => {
    expect(productionProgramEngineHint(engine({ arrivalDate: null })).text).toContain('не прибыл');
    expect(productionProgramEngineHint(engine({ isScrap: true })).text).toContain('Утиль');
  });

  it('отгруженный двигатель в план не берём', () => {
    const hint = productionProgramEngineHint(engine({ shippingDate: 2_000 }));
    expect(hint.tone).toBe('block');
    expect(hint.text).toContain('не берём');
  });
});

/**
 * Этап двигателя в плане (владелец 20.11.2026): колонка «Этап» показывает, где
 * двигатель сейчас, и этап меняется прямо из плана — полной записью в историю
 * ремонта.
 */
describe('этап двигателя в плане', () => {
  it('этап читается из карточки и подписывается с датой', () => {
    const stage = productionProgramEngineStage(
      engine({ lastStageCode: 'sborka', lastStageName: 'Сборка двигателя', lastStageAt: 5_000 }),
    );
    expect(stage?.code).toBe('sborka');
    expect(stage?.name).toBe('Сборка двигателя');
    expect(stage?.at).toBe(5_000);
    expect(stage?.label).toContain('Сборка двигателя');
    expect(stage?.dateLabel).not.toBe('');
  });

  it('этапов ещё не было — этапа нет (в ячейке не врём)', () => {
    expect(productionProgramEngineStage(engine({ lastStageCode: null }))).toBeNull();
    expect(productionProgramEngineStage(null)).toBeNull();
  });

  it('название этапа берётся из реестра, если карточка его не принесла', () => {
    const stage = productionProgramEngineStage(engine({ lastStageCode: 'obkatka', lastStageName: null }));
    expect(stage?.name).toBe('Обкатка двигателя');
  });

  it('меню этапов — по линейке ремонта, текущий помечен', () => {
    const options = productionProgramStageOptions(null, 'sborka');
    // Линейка: приёмка → разборка → укладка → сборка → обкатка → ОТК → отгрузка.
    const codes = options.map((o) => o.code);
    expect(codes.indexOf('sborka')).toBeLessThan(codes.indexOf('obkatka'));
    expect(options.find((o) => o.code === 'sborka')?.isCurrent).toBe(true);
    expect(options.find((o) => o.code === 'obkatka')?.isCurrent).toBe(false);
    // Боковая ветка (утиль и брак) в меню — последней, а не первой.
    expect(codes.at(-1)).toBe('scrap_branch');
  });

  it('соседи этапа: следующий и предыдущий по линейке', () => {
    const { next, prev } = productionProgramStageNeighbours(null, 'sborka');
    expect(next?.code).toBe('obkatka');
    expect(prev?.code).toBe('ukladka');
  });

  it('боковая ветка соседом этапа не считается', () => {
    // «Утиль и брак» — не шаг назад по линейке, а другой исход.
    const { prev } = productionProgramStageNeighbours(null, 'arrival');
    expect(prev?.code).not.toBe('scrap_branch');
  });
});

describe('подсветка строк на печати', () => {  it('готов к отгрузке (обкатка + ОТК) — основная подсветка', () => {
    expect(productionProgramRowHighlight(engine({ lastStageCode: 'otk', lastStageAt: 5_000 }))).toBe('ready');
  });

  it('отгружен — отдельный гриф, без заливки', () => {
    expect(productionProgramRowHighlight(engine({ shippingDate: 6_000 }))).toBe('shipped');
  });

  it('обычный двигатель в ремонте не подсвечивается', () => {
    expect(productionProgramRowHighlight(engine({ lastStageCode: 'ukladka', lastStageAt: 5_000 }))).toBe('none');
  });
});

describe('период программы', () => {
  it('две недели — 14 дней подряд', () => {
    const base = new Date(2026, 10, 1).getTime();
    const period = buildProductionProgramPeriod('two_weeks', base);
    expect(new Date(period.start).getDate()).toBe(1);
    expect(new Date(period.end).getDate()).toBe(14);
  });

  it('месяц — календарный', () => {
    const base = new Date(2026, 10, 9).getTime();
    const period = buildProductionProgramPeriod('month', base);
    expect(new Date(period.start).getDate()).toBe(1);
    expect(new Date(period.end).getDate()).toBe(30);
  });

  it('подпись периода — как в образце', () => {
    const base = new Date(2026, 10, 1).getTime();
    expect(formatProductionProgramPeriod(buildProductionProgramPeriod('two_weeks', base))).toBe(
      'Ноябрь 2026 г. (01.11-14.11)',
    );
  });
});

describe('модель печати', () => {
  const period = buildProductionProgramPeriod('two_weeks', new Date(2026, 10, 1).getTime());

  it('добавленная оператором подпись доходит до модели печати (корень: слоты вне образца терялись)', () => {
    // Заказ владельца 23.11.2026: «в производственную программу открыли на печать, а там
    // надо добавить ещё одну подпись, а мы не можем». Прежде модель собирала подписи ТОЛЬКО
    // из ролей по умолчанию, и добавленный слот молча исчезал.
    const model = buildProductionProgramPrintModel({
      title: 'ПРОИЗВОДСТВЕННАЯ ПРОГРАММА (ЦЕХ № 1)',
      shop: 'Цех № 1',
      period,
      rows: [],
      signatureSlots: [
        { caption: 'Коммерческий директор', employeeId: null, fullName: 'Беркута А.А.' },
        { caption: 'Главный инженер', employeeId: null, fullName: 'Сидоров С.С.' },
      ],
    });

    expect(model.signatures.map((s) => s.caption)).toEqual(['Коммерческий директор', 'Главный инженер']);
    expect(model.signatures[1]?.name).toBe('Сидоров С.С.');
  });

  it('не сохранено ни одной подписи — печатаются роли по умолчанию', () => {
    const model = buildProductionProgramPrintModel({
      title: 'ПРОИЗВОДСТВЕННАЯ ПРОГРАММА (ЦЕХ № 1)',
      shop: 'Цех № 1',
      period,
      rows: [],
      signatureSlots: null,
    });

    expect(model.signatures).toHaveLength(PRODUCTION_PROGRAM_SIGNATURE_SLOTS.length);
  });

  it('строки группируются по договору, «№ п/п» сквозной по перевозчикам', () => {
    const model = buildProductionProgramPrintModel({
      title: 'ПРОИЗВОДСТВЕННАЯ ПРОГРАММА (ЦЕХ № 1)',
      shop: 'Цех № 1',
      period,
      rows: [
        {
          id: 'r1',
          contractId: 'c1',
          groupLabel: 'АО «Уралтрансмаш» Договор 2224.',
          contractKind: 'military',
          engineId: 'e1',
          engineMark: 'ТМЗ',
          engineNumber: '001',
          state: 'restoration',
        },
        {
          id: 'r2',
          contractId: 'c1',
          groupLabel: 'АО «Уралтрансмаш» Договор 2224.',
          contractKind: 'military',
          engineId: 'e2',
          engineMark: 'ТМЗ',
          engineNumber: '002',
          state: 'repairable',
        },
        {
          id: 'r3',
          contractId: 'c2',
          groupLabel: 'ООО «Заказчик» Договор 999.',
          contractKind: 'civil',
          engineId: 'e3',
          engineMark: 'ТМЗ',
          engineNumber: '003',
          state: 'capital_repair',
        },
      ],
    });

    expect(model.groups).toHaveLength(2);
    expect(model.groups[0]?.rows).toHaveLength(2);
    expect(model.groups[0]?.rows.map((r) => r.orderNo)).toEqual([1, 2]);
    expect(model.groups[1]?.rows.map((r) => r.orderNo)).toEqual([3]);
    expect(model.engineCount).toBe(3);
    expect(model.groups[0]?.rows[0]?.contractKind).toBe('military');
    expect(model.signatures).toHaveLength(7);
  });

  it('подсветка строки считается по факту из карточки двигателя', () => {
    const model = buildProductionProgramPrintModel({
      title: 'ПП',
      shop: 'Цех № 1',
      period,
      rows: [
        { id: 'r1', engineId: 'ready', engineMark: 'ТМЗ', engineNumber: '001' },
        { id: 'r2', engineId: 'shipped', engineMark: 'ТМЗ', engineNumber: '002' },
      ],
      engines: [
        engine({ id: 'ready', lastStageCode: 'otk', lastStageAt: 5_000 }),
        engine({ id: 'shipped', shippingDate: 6_000 }),
      ],
    });
    expect(model.groups[0]?.rows[0]?.highlight).toBe('ready');
    expect(model.groups[0]?.rows[1]?.highlight).toBe('shipped');
  });
});

// Оператору — человеческие наименования. Технический идентификатор в подписи
// договора — это «номер вместо наименования»: в отчёте перед подписью директора
// он выглядит как служебная выгрузка.
describe('человеческие наименования в плане', () => {
  const UUID = '9e142af3-caf9-427f-9893-58961e48d4b1';

  it('технический идентификатор опознаётся общим проектным детектором', () => {
    expect(looksLikeIdentifier(UUID)).toBe(true);
    expect(looksLikeIdentifier('125/2026')).toBe(false);
    expect(looksLikeIdentifier('ООО «Малмыжский РМЗ»')).toBe(false);
    expect(looksLikeIdentifier('')).toBe(false);
    expect(looksLikeIdentifier(null)).toBe(false);
  });

  it('подпись договора — организация и номер', () => {
    expect(productionProgramContractLabel({ organization: 'ООО «Заказчик»', contractNumber: '125/2026' })).toBe(
      'ООО «Заказчик» · 125/2026',
    );
    expect(productionProgramContractLabel({ organization: 'ООО «Заказчик»', contractNumber: '' })).toBe('ООО «Заказчик»');
    expect(productionProgramContractLabel({ organization: '', contractNumber: '125/2026' })).toBe('125/2026');
  });

  it('идентификатор в подпись не идёт — ни вместо организации, ни вместо номера', () => {
    expect(productionProgramContractLabel({ organization: UUID, contractNumber: '125/2026' })).toBe('125/2026');
    expect(productionProgramContractLabel({ organization: 'ООО «Заказчик»', contractNumber: UUID })).toBe('ООО «Заказчик»');
    expect(productionProgramContractLabel({ organization: UUID, contractNumber: UUID })).toBe('');
  });

  it('шапка группы: идентификатор печатается прочерком', () => {
    expect(productionProgramGroupLabel('ООО «Заказчик» · 125/2026')).toBe('ООО «Заказчик» · 125/2026');
    expect(productionProgramGroupLabel(UUID)).toBe(HUMAN_LABEL_DASH);
    expect(productionProgramGroupLabel('')).toBe(HUMAN_LABEL_DASH);
  });

  it('в печатной форме идентификатор группы не печатается', () => {
    const model = buildProductionProgramPrintModel({
      title: 'ПП',
      shop: 'Цех № 1',
      period: { start: Date.UTC(2026, 10, 1, 12), end: Date.UTC(2026, 10, 15, 12) },
      rows: [{ id: 'r1', groupLabel: UUID, engineMark: 'Д-245', engineNumber: '001' }],
    });
    expect(model.groups[0]?.label).toBe(HUMAN_LABEL_DASH);
    expect(model.groups[0]?.rows[0]?.groupLabel).toBe(HUMAN_LABEL_DASH);
  });
});

/**
 * Колонка «Организация» печатной формы и плана: заказчик и ТРИ ЦИФРЫ номера
 * договора (те, что до первого слэша — `shortContractSuffix`).
 *
 * Владелец (10.11.2026): «в колонке организация нужно писать название заказчика и
 * номер договора, но только три цифры, те самые три цифры, которые у нас до
 * слэша… вот их нужно подставлять в отчёт при печати».
 */
describe('подпись «Организация»: заказчик и три цифры номера договора', () => {
  it('берёт последние три цифры части до слэша', () => {
    expect(productionProgramOrganizationLabel({ customerName: 'ООО «Заказчик»', contractNumber: '239/27/ГОЗ-24' })).toBe(
      'ООО «Заказчик» · *239',
    );
    expect(
      productionProgramOrganizationLabel({ customerName: 'ООО «Заказчик»', contractNumber: '2325187913551442245231239/27/ГОЗ-24' }),
    ).toBe('ООО «Заказчик» · *239');
  });

  it('без слэша номер показывается как есть (правило владельца 22.09.2026)', () => {
    expect(productionProgramOrganizationLabel({ customerName: 'ООО «Заказчик»', contractNumber: '125/2026' })).toBe(
      'ООО «Заказчик» · *125',
    );
    expect(productionProgramOrganizationLabel({ customerName: 'ООО «Заказчик»', contractNumber: 'Письмо № 15' })).toBe(
      'ООО «Заказчик» · Письмо № 15',
    );
  });

  it('технический идентификатор в подпись не идёт', () => {
    expect(
      productionProgramOrganizationLabel({
        customerName: 'ООО «Заказчик»',
        contractNumber: '9e142af3-caf9-427f-9893-58961e48d4b1',
      }),
    ).toBe('ООО «Заказчик»');
  });

  it('пустые части не дают пустой подписи с разделителем', () => {
    expect(productionProgramOrganizationLabel({ customerName: '', contractNumber: '' })).toBe('');
    expect(productionProgramOrganizationLabel({})).toBe('');
  });

  it('в печатной форме колонка «Организация» — живая подпись из карточки', () => {
    const model = buildProductionProgramPrintModel({
      title: 'ПП',
      shop: 'Цех № 1',
      period: { start: Date.UTC(2026, 10, 1, 12), end: Date.UTC(2026, 10, 15, 12) },
      rows: [{ id: 'r1', groupLabel: 'ООО «Заказчик» · 239/27/ГОЗ-24', engineId: 'e1' }],
      engines: [engine({ id: 'e1', customerName: 'ООО «Заказчик»', contractName: '239/27/ГОЗ-24' })],
    });
    expect(model.groups[0]?.rows[0]?.organizationLabel).toBe('ООО «Заказчик» · *239');
  });
});

/**
 * Вид периода выводится из дат: программа, сохранённая с произвольными датами,
 * не должна выглядеть как двухнедельная.
 */
describe('вид периода выводится из дат', () => {
  it('календарный месяц — «месяц»', () => {
    expect(productionProgramPeriodKind({ start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 30) })).toBe('month');
  });

  it('ровно 14 дней — «две недели»', () => {
    expect(productionProgramPeriodKind({ start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 14) })).toBe('two_weeks');
  });

  it('произвольные даты — «свои даты»', () => {
    expect(productionProgramPeriodKind({ start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 20) })).toBe('custom');
  });
});

/**
 * План следит за выполнением сам (владелец 10.11.2026): «если прошёл контроль АТК,
 * то в плане должно ставиться отметка, что план по двигателю выполнен… показывать,
 * сколько двигателей ещё не собраны, невыполнены, сколько выполнены».
 */
describe('выполнение плана по факту из карточки двигателя', () => {
  const NOW = Date.UTC(2026, 10, 10);

  it('ОТК пройден, но не отгружен — «готов к отгрузке», это выполнено', () => {
    const res = productionProgramRowExecution({
      engine: engine({ lastStageCode: 'otk', lastStageAt: 5_000, arrivalDate: 1_000 }),
      shippingPlanAt: Date.UTC(2026, 10, 20),
      now: NOW,
    });
    expect(res.state).toBe('ready');
    expect(res.stateLabel).toBe('Готов к отгрузке');
    expect(res.onTime).toBe(true);
  });

  it('отгружен — выполнено', () => {
    const res = productionProgramRowExecution({
      engine: engine({ shippingDate: Date.UTC(2026, 10, 5), arrivalDate: 1_000 }),
      shippingPlanAt: Date.UTC(2026, 10, 20),
      now: NOW,
    });
    expect(res.state).toBe('shipped');
    expect(res.onTime).toBe(true);
  });

  it('на заводе, но без ОТК — в работе', () => {
    const res = productionProgramRowExecution({
      engine: engine({ arrivalDate: 1_000 }),
      shippingPlanAt: Date.UTC(2026, 10, 20),
      now: NOW,
    });
    expect(res.state).toBe('inWork');
  });

  it('не прибыл — не начат', () => {
    const res = productionProgramRowExecution({
      engine: engine({ arrivalDate: null }),
      shippingPlanAt: Date.UTC(2026, 10, 20),
      now: NOW,
    });
    expect(res.state).toBe('notStarted');
  });

  it('срок вышел, а двигатель не отгружен — просрочен', () => {
    const res = productionProgramRowExecution({
      engine: engine({ arrivalDate: 1_000 }),
      shippingPlanAt: Date.UTC(2026, 10, 1),
      now: NOW,
    });
    expect(res.overdue).toBe(true);
    expect(res.onTime).toBe(false);
  });

  it('отгрузили позже плановой даты — выпал из сроков', () => {
    const res = productionProgramRowExecution({
      engine: engine({ arrivalDate: 1_000, shippingDate: Date.UTC(2026, 10, 15) }),
      shippingPlanAt: Date.UTC(2026, 10, 1),
      now: NOW,
    });
    expect(res.state).toBe('shipped');
    expect(res.overdue).toBe(true);
  });

  it('без плановой даты срок не судим', () => {
    const res = productionProgramRowExecution({ engine: engine({ arrivalDate: 1_000 }), shippingPlanAt: null, now: NOW });
    expect(res.onTime).toBeNull();
    expect(res.overdue).toBe(false);
  });

  it('сводка плана считает собрано, не собрано, в срок и просрочено', () => {
    const summary = productionProgramExecutionSummary({
      rows: [
        { engineId: 'ready', shippingPlanAt: Date.UTC(2026, 10, 20) },
        { engineId: 'shipped', shippingPlanAt: Date.UTC(2026, 10, 20) },
        { engineId: 'work', shippingPlanAt: Date.UTC(2026, 10, 1) },
        { engineId: 'late', shippingPlanAt: Date.UTC(2026, 10, 1) },
      ],
      engines: [
        engine({ id: 'ready', lastStageCode: 'otk', lastStageAt: 5_000, arrivalDate: 1_000 }),
        engine({ id: 'shipped', arrivalDate: 1_000, shippingDate: Date.UTC(2026, 10, 5) }),
        engine({ id: 'work', arrivalDate: 1_000 }),
        engine({ id: 'late', arrivalDate: 1_000, shippingDate: Date.UTC(2026, 10, 15) }),
      ],
      now: NOW,
    });
    expect(summary.total).toBe(4);
    // Выполнено три: готов к отгрузке, отгружен в срок и отгружен с опозданием.
    expect(summary.done).toBe(3);
    expect(summary.ready).toBe(1);
    expect(summary.shipped).toBe(2);
    expect(summary.inWork).toBe(1);
    expect(summary.onTime).toBe(2);
    expect(summary.overdue).toBe(2);
  });
});

describe('строка плана из карточки двигателя (#44/#45)', () => {
  it('значения берутся из карточки, состояние — из вида договора', () => {
    const row = productionProgramRowFromEngine({
      id: 'row-1',
      engine: engine({
        id: 'e42',
        engineBrand: 'В-59УМС',
        engineNumber: '240-1',
        contractId: 'contract-1',
      }),
      groupLabel: 'Заказчик · 125/2',
      contractKind: 'military',
    });
    expect(row.id).toBe('row-1');
    expect(row.engineId).toBe('e42');
    expect(row.engineMark).toBe('В-59УМС');
    expect(row.engineNumber).toBe('240-1');
    expect(row.contractId).toBe('contract-1');
    expect(row.groupLabel).toBe('Заказчик · 125/2');
    // Военный договор — восстановление или ремонтопригодность.
    expect(row.state).toBe('restoration');
    expect(row.shippingPlanAt).toBeNull();
    expect(row.factors).toBe('');
    expect(row.note).toBe('');
  });

  it('гражданский договор — капитальный ремонт; без вида договора берётся вид двигателя', () => {
    const civil = productionProgramRowFromEngine({
      id: 'row-2',
      engine: engine({ id: 'e43', contractId: 'contract-2' }),
      groupLabel: 'Заказчик · 77/1',
      contractKind: 'civil',
    });
    expect(civil.state).toBe('capital_repair');
    // Разделов договора нет — вид берём у двигателя (тот же источник: договор → карточка).
    const byEngineKind = productionProgramRowFromEngine({
      id: 'row-3',
      engine: engine({ id: 'e44', contractId: null, kind: 'civil' }),
      groupLabel: 'Заказчик · 1/1',
      contractKind: null,
    });
    expect(byEngineKind.contractId).toBeNull();
    expect(byEngineKind.contractKind).toBe('civil');
    expect(byEngineKind.state).toBe('capital_repair');
  });

  it('двигатель без договора даёт строку без группы — её в план брать нельзя', () => {
    const row = productionProgramRowFromEngine({
      id: 'row-4',
      engine: engine({ id: 'e45', contractId: null }),
      groupLabel: '',
      contractKind: null,
    });
    expect(row.groupLabel).toBe('');
    expect(row.contractId).toBeNull();
  });
});
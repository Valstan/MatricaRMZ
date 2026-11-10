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
  productionProgramGroupLabel,
  productionProgramOrganizationLabel,
  productionProgramPeriodKind,
  productionProgramRowHighlight,
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
  it('в образце 8 строк подписи, гриф утверждения отдельный', () => {
    expect(PRODUCTION_PROGRAM_SIGNATURE_SLOTS).toHaveLength(8);
    expect(PRODUCTION_PROGRAM_SIGNATURE_SLOTS[0]?.caption).toBe('Коммерческий директор');
    expect(PRODUCTION_PROGRAM_SIGNATURE_SLOTS.at(-1)?.caption).toBe('Директор');
  });

  it('несохранённые слоты достраиваются ФИО из образца', () => {
    const slots = resolveProductionProgramSignatureSlots(null);
    expect(slots).toHaveLength(8);
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

  it('подбор по должности находит сотрудника; «Директор» не достаёт коммерческого директора', () => {
    const employees = [
      { id: 'emp-1', fullName: 'Беркута Алексей Алексеевич', position: 'Коммерческий директор', employmentStatus: 'working' },
      { id: 'emp-2', fullName: 'Тихомиров Иван Анатольевич', position: 'Директор', employmentStatus: 'working' },
    ];
    const commercial = PRODUCTION_PROGRAM_SIGNATURE_SLOTS.find((s) => s.caption === 'Коммерческий директор')!;
    const director = PRODUCTION_PROGRAM_SIGNATURE_SLOTS.find((s) => s.caption === 'Директор')!;
    expect(findProductionProgramSignatory(employees, commercial)?.id).toBe('emp-1');
    expect(findProductionProgramSignatory(employees, director)?.id).toBe('emp-2');
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

describe('подсветка строк на печати', () => {
  it('готов к отгрузке (обкатка + ОТК) — основная подсветка', () => {
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
    expect(model.signatures).toHaveLength(8);
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

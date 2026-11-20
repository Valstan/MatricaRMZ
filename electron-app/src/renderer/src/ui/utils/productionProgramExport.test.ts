import { describe, expect, it } from 'vitest';

import {
  buildProductionProgramClipboardText,
  buildProductionProgramExportRows,
  buildProductionProgramExportSpec,
} from './productionProgramExport.js';

// Выгрузка плана ПП в Word/Excel и в буфер обмена (промты КАРМАНА #50/#51).
//
// Что тут важно: файл собирается из ТОЙ ЖЕ модели печати, что и лист, поэтому
// проверяем не «как выглядит файл», а совпадение чисел и подписей с планом:
// сквозной «№ п/п», номер внутри договора, организация, договор, этап, состояние.
// Расхождение здесь — это «на бумаге одно, в Excel другое».

const INPUT = {
  title: 'ПРОИЗВОДСТВЕННАЯ ПРОГРАММА (ЦЕХ № 1)',
  shop: 'Цех № 1',
  period: { start: Date.UTC(2026, 10, 1, 12), end: Date.UTC(2026, 10, 15, 12) },
  rows: [
    {
      id: 'r1',
      contractId: 'c1',
      groupLabel: 'ООО «Заказчик» № 125/2026',
      contractKind: 'military' as const,
      engineId: 'e1',
      engineMark: 'Д-245',
      engineNumber: '001',
      state: 'restoration',
      note: '',
    },
    {
      id: 'r2',
      contractId: 'c1',
      groupLabel: 'ООО «Заказчик» № 125/2026',
      contractKind: 'military' as const,
      engineId: 'e2',
      engineMark: 'Д-245',
      engineNumber: '002',
      state: 'repairable',
      note: 'ждать деталь',
    },
    {
      id: 'r3',
      contractId: 'c2',
      groupLabel: 'АО «Второй заказчик» № 7/2026',
      contractKind: 'civil' as const,
      engineId: 'e3',
      engineMark: 'Д-245',
      engineNumber: '003',
      state: 'capital_repair',
      note: '',
    },
  ],
  engines: [
    {
      id: 'e1',
      engineNumber: '001',
      engineBrand: 'Д-245',
      customerName: 'ООО «Заказчик»',
      contractName: '125/2026',
      statusFlags: { status_repaired: true },
      lastStageCode: 'otk',
      lastStageAt: Date.UTC(2026, 10, 13, 12),
    },
    {
      id: 'e2',
      engineNumber: '002',
      engineBrand: 'Д-245',
      customerName: 'ООО «Заказчик»',
      contractName: '125/2026',
      statusFlags: { status_customer_sent: true },
      shippingDate: Date.UTC(2026, 10, 12, 12),
    },
    {
      id: 'e3',
      engineNumber: '003',
      engineBrand: 'Д-245',
      customerName: 'АО «Второй заказчик»',
      contractName: '7/2026',
      statusFlags: {},
    },
  ] as never[],
};

describe('выгрузка плана производственной программы', () => {
  it('строки идут в порядке групп, сквозной номер — по позиции', () => {
    const rows = buildProductionProgramExportRows(INPUT as never);
    expect(rows.map((r) => r.orderNo)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.inContractNo)).toEqual([1, 2, 1]);
    expect(rows.map((r) => r.contract)).toEqual([
      'ООО «Заказчик» № 125/2026',
      'ООО «Заказчик» № 125/2026',
      'АО «Второй заказчик» № 7/2026',
    ]);
  });

  it('двигатель, состояние и примечание — как на экране (подпись, а не значение из базы)', () => {
    const rows = buildProductionProgramExportRows(INPUT as never);
    expect(rows[0]?.engine).toBe('Д-245 001');
    expect(rows[0]?.state).toBe('Восстановление');
    // Организация — живая подпись из карточки двигателя: заказчик и рабочий номер.
    expect(rows[0]?.organization).toBe('ООО «Заказчик» · *125');
    expect(rows[2]?.organization).toBe('АО «Второй заказчик» · *7');
    expect(rows[1]?.note).toBe('ждать деталь');
    expect(rows[2]?.state).toBe('Капитальный ремонт');
  });

  it('этап у отгруженного без строки этапа — «Отгружен», а не пусто', () => {
    const rows = buildProductionProgramExportRows(INPUT as never);
    // У e2 этапа нет, но он отгружен: на листе гриф «Отгружен» — в файле должно быть то же.
    expect(rows[1]?.stage).toBe('Отгружен');
    // У e3 нет ни этапа, ни отгрузки — пусто, а не выдуманный гриф.
    expect(rows[2]?.stage).toBe('');
  });

  it('спека для общего экспортёра: номер первым, номера — числа, строки по числу двигателей', () => {
    const { spec } = buildProductionProgramExportSpec(INPUT as never);
    expect(spec.columns[0]).toEqual({ label: '№', kind: 'number' });
    expect(spec.columns.map((c) => c.label)).toEqual([
      '№',
      '№ в договоре',
      'Организация',
      'Договор',
      'Двигатель',
      'Этап',
      'Состояние',
      'Примечание',
    ]);
    // Номер — число: иначе Excel сортирует «10» перед «9».
    expect(spec.columns.find((c) => c.label === '№ в договоре')?.kind).toBe('number');
    expect(spec.rows).toHaveLength(3);
    expect(spec.rows[0]?.[0]).toBe('1');
    expect(spec.rows[0]?.[1]).toBe('1');
    expect(spec.filters.some((f) => f.includes('Цех № 1'))).toBe(true);
    expect(spec.filters.some((f) => f.includes('Двигателей в плане: 3'))).toBe(true);
  });

  it('марка и номер — живые (карточка), снимок строки — запасной вариант', () => {
    // Карточка двигателя переименована после того, как строка попала в план:
    // план не живёт отдельной жизнью — показываем живое, снимок только как запасной.
    const stale = buildProductionProgramExportRows({
      ...INPUT,
      rows: [
        {
          id: 'r1',
          contractId: 'c1',
          groupLabel: 'ООО «Заказчик» № 125/2026',
          engineId: 'e1',
          engineMark: 'СТАРЫЙ',
          engineNumber: 'СТАРЫЙ-001',
          state: 'restoration',
          note: '',
        },
        {
          id: 'r2',
          contractId: 'c1',
          groupLabel: 'ООО «Заказчик» № 125/2026',
          engineId: 'e9',
          engineMark: 'ИЗ СНИМКА',
          engineNumber: 'ИЗ-СНИМКА-002',
          state: 'restoration',
          note: '',
        },
      ],
      engines: [
        { id: 'e1', engineBrand: 'Д-245', engineNumber: '001', statusFlags: {} },
        // Карточки e9 нет (двигатель уехал из картотеки) — показываем снимок строки.
      ] as never[],
    } as never);
    expect(stale[0]?.engine).toBe('Д-245 001');
    expect(stale[1]?.engine).toBe('ИЗ СНИМКА ИЗ-СНИМКА-002');
  });

  it('буфер обмена: шапка и строки через табуляцию — вставится таблицей', () => {
    const text = buildProductionProgramClipboardText(INPUT as never);
    const lines = text.split('\n');
    expect(lines[0]).toBe('№ п/п\t№ в договоре\tОрганизация\tДоговор\tДвигатель\tЭтап\tСостояние\tПримечание');
    expect(lines).toHaveLength(4);
    expect(lines[1]?.startsWith('1\t1\t')).toBe(true);
    expect(lines[1]).toContain('Д-245 001');
  });

  it('буфер обмена режет длинный список и говорит об этом', () => {
    const text = buildProductionProgramClipboardText(INPUT as never, 2);
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('и ещё 1 строк');
  });
});

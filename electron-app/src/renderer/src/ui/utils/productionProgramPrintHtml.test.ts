import { describe, expect, it } from 'vitest';

import { productionProgramPrintHtml } from './productionProgramPrintHtml.js';

// Печатная форма ПП — по образцу «ПП Цех № 1»: A4 landscape, поля 12,7 мм, семь
// колонок заданной ширины, кегль не меньше 14 pt (требование владельца важнее
// совпадения с образцом), шапки групп, гриф «УТВЕРЖДАЮ» и сетка подписей.
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
      shippingPlanAt: Date.UTC(2026, 10, 14, 12),
      factors: 'Ждём детали',
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
      shippingPlanAt: null,
      factors: '',
      note: 'уже отгружен',
    },
  ],
  engines: [
    {
      id: 'e1',
      engineNumber: '001',
      engineBrand: 'Д-245',
      statusFlags: { status_repaired: true },
      lastStageCode: 'otk',
      lastStageAt: Date.UTC(2026, 10, 13, 12),
    },
    {
      id: 'e2',
      engineNumber: '002',
      engineBrand: 'Д-245',
      statusFlags: { status_customer_sent: true },
      shippingDate: Date.UTC(2026, 10, 12, 12),
    },
  ] as never[],
};

describe('печатная форма производственной программы', () => {
  const html = productionProgramPrintHtml(INPUT as never);

  it('лист: A4 landscape, поля 12,7 мм, Times New Roman', () => {
    expect(html).toContain('@page { size: A4 landscape; margin: 12.7mm; }');
    expect(html).toContain('"Times New Roman"');
  });

  it('кегль не меньше 14 pt', () => {
    // Шапка таблицы и подписи печатаются 14 pt — требование владельца (в образце 12 pt,
    // но читать форму на цеховом принтере невозможно).
    expect(html).toContain('font-size:14pt');
    expect(html).not.toContain('font-size:12pt');
  });

  it('семь колонок заданной ширины (в сумме — печатная полоса 271 мм)', () => {
    for (const width of [15.7, 47.8, 62.0, 39.5, 28.1, 43.0, 34.8]) {
      expect(html).toContain(`width:${width}mm`);
    }
    expect(html).toContain('<colgroup>');
  });

  it('заголовки колонок — как в образце', () => {
    for (const head of [
      '№ п/п',
      'Организация',
      'Марка и номер двигателя',
      'Состояние',
      'Отгрузка',
      'Факторы, влияющие на выполнение плана',
      'Примечание',
    ]) {
      expect(html).toContain(head);
    }
  });

  it('гриф «УТВЕРЖДАЮ» и сетка подписей на месте', () => {
    expect(html).toContain('УТВЕРЖДАЮ');
    expect(html).toContain('Директор АО «Малмыжский РМЗ»');
    expect(html).toContain('Коммерческий директор');
    expect(html).toContain('Начальник цеха №1');
  });

  it('строка двигателя: состояние подписью, номер п/п и организация', () => {
    expect(html).toContain('Восстановление');
    expect(html).toContain('Д-245 001');
    expect(html).toContain('ООО «Заказчик» № 125/2026');
  });

  it('готовый к отгрузке двигатель подсвечен, отгруженный — грифом без заливки', () => {
    // Решение владельца: основная подсветка — «готов к отгрузке»; отгруженные строки
    // получают гриф «Отгружен» БЕЗ заливки, иначе весь план «позеленеет».
    expect(html).toContain('background:#dcfce7');
    expect(html).toContain('(отгружен)');
    // Подсветка — только у готового к отгрузке: у отгруженной строки заливки нет.
    const shippedRow = html.slice(html.indexOf('002'));
    expect(shippedRow).not.toContain('background:#dcfce7');
  });
});

/**
 * Настройки печати (владелец 10.11.2026): превью с галочками подписей и
 * регулировкой кеглей, подписи вертикально в два столбца.
 */
describe('настройки печатной формы ПП', () => {
  it('подписи идут вертикально в два столбца, а не в одну строку', () => {
    // Восемь подписей в одну строку занимали половину листа (владелец: «подписи
    // должны идти друг под дружкой… можно в два столбца»).
    const html = productionProgramPrintHtml(INPUT as never);
    const signatureTable = html.slice(html.indexOf('Коммерческий директор'));
    expect(signatureTable).toContain('width:50%');
    // Строк подписей вдвое меньше, чем подписей (две в ряд).
    const rows = signatureTable.match(/<tr>/g) ?? [];
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThan(8);
  });

  it('кегли разделов настраиваются: шапка, список, подписи', () => {
    const html = productionProgramPrintHtml(INPUT as never, {
      headerFontSize: 18,
      tableFontSize: 11,
      signatureFontSize: 12,
    });
    expect(html).toContain('font-size:18pt');
    expect(html).toContain('font-size:11pt');
    expect(html).toContain('font-size:12pt');
  });

  it('снятая подпись не печатается', () => {
    const html = productionProgramPrintHtml(INPUT as never, {
      signatureCaptions: ['Коммерческий директор'],
    });
    expect(html).toContain('Коммерческий директор');
    expect(html).not.toContain('Начальник цеха №1');
  });

  it('кегль не выходит за разумные пределы', () => {
    const html = productionProgramPrintHtml(INPUT as never, { tableFontSize: 2 });
    expect(html).toContain('font-size:8pt');
    expect(html).not.toContain('font-size:2pt');
  });
});

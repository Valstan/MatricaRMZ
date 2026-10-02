import { describe, expect, it } from 'vitest';

import {
  buildEngineTagsHtml,
  buildEngineTagsHtmlWithQr,
  engineTagQrValue,
  splitContractDigits,
  technicalAcceptanceDate,
  TECHNICAL_ACCEPTANCE_LAG_DAYS,
  type EngineTagData,
} from './engineTagPrint.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ARRIVAL = Date.UTC(2026, 0, 12, 9, 0, 0);
const REPAIR_START = Date.UTC(2026, 0, 20, 9, 0, 0);
const REPAIR_DUE = Date.UTC(2026, 3, 12, 9, 0, 0);

function tag(n: number): EngineTagData {
  return {
    engineBrand: '6ЧН 21/21',
    engineNumber: `Д-00${n}`,
    engineId: `eng-${n}`,
    customerName: 'РЖД ТЧЭ-5',
    contractNumber: 'ДГ-12/2026-СЕВ',
    arrivalDate: ARRIVAL,
    repairStartDate: REPAIR_START,
    repairDueDate: REPAIR_DUE,
  };
}

function tags(count: number): EngineTagData[] {
  return Array.from({ length: count }, (_, i) => tag(i + 1));
}

function sheetCount(html: string): number {
  return html.match(/class="sheet"/g)?.length ?? 0;
}

/** Кегль номера двигателя — по нему видно, что раскладка сменила набор размеров. */
function numberPt(html: string): string {
  return html.match(/\.tag-number \{ font-size: ([\d.]+)pt/)?.[1] ?? '';
}

const PORTRAIT = { orientation: 'portrait' as const };

describe('buildEngineTagsHtml', () => {
  it('режет бирки на листы по выбранной раскладке', () => {
    expect(sheetCount(buildEngineTagsHtml(tags(6), { perSheet: 6, ...PORTRAIT }))).toBe(1);
    expect(sheetCount(buildEngineTagsHtml(tags(6), { perSheet: 4, ...PORTRAIT }))).toBe(2);
    expect(sheetCount(buildEngineTagsHtml(tags(6), { perSheet: 2, ...PORTRAIT }))).toBe(3);
    expect(sheetCount(buildEngineTagsHtml(tags(7), { perSheet: 6, ...PORTRAIT }))).toBe(2);
  });

  it('печатает все поля бирки', () => {
    const html = buildEngineTagsHtml([tag(1)], { perSheet: 4, ...PORTRAIT });
    expect(html).toContain('6ЧН 21/21');
    expect(html).toContain('Д-001');
    expect(html).toContain('РЖД ТЧЭ-5');
    expect(html).toContain('ДГ-12/2026-СЕВ');
    expect(html).toContain('Заказчик');
    expect(html).toContain('Поступил на завод');
    expect(html).toContain('Начало ремонта');
    expect(html).toContain('Окончание ремонта по договору');
    expect(html).toContain('Окончательная техническая приёмка');
    expect(html).toContain('12.01.2026');
    expect(html).toContain('20.01.2026');
    expect(html).toContain('12.04.2026');
    // Техприёмка = срок ремонта + запас (10 дней).
    expect(html).toContain('22.04.2026');
  });

  it('пустое значение печатает прочерком', () => {
    const html = buildEngineTagsHtml(
      [{ engineBrand: '', engineNumber: 'Д-009', engineId: 'eng-9', customerName: '  ', contractNumber: '', arrivalDate: null }],
      { perSheet: 6, ...PORTRAIT },
    );
    expect(html).toContain('Д-009');
    // Пустых значений четыре (марка, заказчик, договор, поступление) плюс две несчитаемые даты.
    expect(html.match(/—/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(html).not.toContain('<div class="tag-value"></div>');
  });

  it('три раскладки дают разные кегли', () => {
    const six = numberPt(buildEngineTagsHtml(tags(1), { perSheet: 6, ...PORTRAIT }));
    const four = numberPt(buildEngineTagsHtml(tags(1), { perSheet: 4, ...PORTRAIT }));
    const two = numberPt(buildEngineTagsHtml(tags(1), { perSheet: 2, ...PORTRAIT }));
    expect(new Set([six, four, two]).size).toBe(3);
    expect(Number(six)).toBeLessThan(Number(four));
    expect(Number(four)).toBeLessThan(Number(two));
  });

  it('раскладка задаёт сетку и высоту ряда от печатной области A4', () => {
    // 6 на лист: 2 колонки × 3 ряда, высота ряда = (297 − 2×7 − 1 − 2×2) / 3 = 92.67мм.
    const html = buildEngineTagsHtml(tags(6), { perSheet: 6, ...PORTRAIT });
    expect(html).toContain('grid-template-columns: repeat(2, 1fr)');
    expect(html).toContain('grid-template-rows: repeat(3, 92.67mm)');
    expect(html).toContain('@page { size: A4; margin: 7mm; }');
    // 2 на лист: одна колонка.
    expect(buildEngineTagsHtml(tags(2), { perSheet: 2, ...PORTRAIT })).toContain('grid-template-columns: repeat(1, 1fr)');
  });

  it('альбом: сетка зеркальная, @page landscape', () => {
    // 4 на альбом: 2 × 2, высота ряда = (210 − 2×7 − 1 − 4) / 2 = 95.5мм.
    const html = buildEngineTagsHtml(tags(4), { perSheet: 4, orientation: 'landscape' });
    expect(html).toContain('@page { size: A4 landscape; margin: 7mm; }');
    expect(html).toContain('grid-template-columns: repeat(2, 1fr)');
    expect(html).toContain('grid-template-rows: repeat(2, 95.5mm)');
    expect(sheetCount(html)).toBe(1);
    // 6 на альбом: 3 колонки.
    expect(buildEngineTagsHtml(tags(6), { perSheet: 6, orientation: 'landscape' })).toContain(
      'grid-template-columns: repeat(3, 1fr)',
    );
  });

  it('QR: значение — engine:<id>, svg в шапке справа от номера', () => {
    expect(engineTagQrValue('abc-123')).toBe('engine:abc-123');
    const qr = new Map([['eng-1', '<svg>qr</svg>']]);
    const html = buildEngineTagsHtml([tag(1)], { perSheet: 4, ...PORTRAIT }, qr);
    expect(html).toContain('<div class="tag-qr"><svg>qr</svg></div>');
    expect(html).toContain('.tag-qr {');
  });

  it('QR: бирка без svg в карте печатается без квадрата, а не дыркой', () => {
    const html = buildEngineTagsHtml([tag(1)], { perSheet: 4, ...PORTRAIT }, new Map());
    expect(html).not.toContain('<div class="tag-qr">');
    expect(html).toContain('Д-001');
  });

  it('асинхронная сборка генерирует настоящий QR на каждый двигатель', async () => {
    const html = await buildEngineTagsHtmlWithQr(tags(2), { perSheet: 4, ...PORTRAIT });
    // Два разных двигателя — два разных svg в шапках.
    expect(html.match(/<div class="tag-qr">/g)?.length ?? 0).toBe(2);
    expect(html).toContain('<svg');
    expect(html).toContain('Д-001');
    expect(html).toContain('Д-002');
  });
});

describe('splitContractDigits', () => {
  it('три последние цифры до слэша — отдельно', () => {
    expect(splitContractDigits('239/27/ГОЗ-24')).toEqual({ head: '', digits: '239', tail: '/27/ГОЗ-24' });
    expect(splitContractDigits('2325187913551442245231239/27/ГОЗ-24')).toEqual({
      head: '2325187913551442245231',
      digits: '239',
      tail: '/27/ГОЗ-24',
    });
  });

  it('меньше трёх цифр, без цифр и без номера — null, печатается как есть', () => {
    expect(splitContractDigits('ДГ-12/2026-СЕВ')).toBeNull();
    expect(splitContractDigits('без цифр вовсе')).toBeNull();
    expect(splitContractDigits('')).toBeNull();
    expect(splitContractDigits('12')).toBeNull();
  });

  it('цифры на бирке жирные и крупные, остальное — как было', () => {
    const html = buildEngineTagsHtml(
      [{ ...tag(1), contractNumber: '239/27/ГОЗ-24' }],
      { perSheet: 4, orientation: 'landscape' },
    );
    expect(html).toContain('<span class="tag-contract-digits">239</span>');
    expect(html).toContain('/27/ГОЗ-24');
    expect(html).toContain('.tag-contract-digits { font-size: 24pt; font-weight: 800; }');
  });
});

describe('technicalAcceptanceDate', () => {
  it('отодвигает срок ремонта на запас технической приёмки', () => {
    expect(technicalAcceptanceDate(REPAIR_DUE)).toBe(REPAIR_DUE + TECHNICAL_ACCEPTANCE_LAG_DAYS * DAY_MS);
  });

  it('без срока ремонта считать не от чего', () => {
    expect(technicalAcceptanceDate(null)).toBeNull();
    expect(technicalAcceptanceDate(undefined)).toBeNull();
  });
});

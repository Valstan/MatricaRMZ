import { describe, expect, it } from 'vitest';

import {
  PRINT_FONT_STEPS,
  ROW_NUMBER_COLUMN_MM,
  planListPrintLayout,
  printableWidthMm,
  type PrintColumnSpec,
} from './listPrintLayout.js';

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

function dataWidth(columns: readonly PrintColumnSpec[], orientation: 'portrait' | 'landscape' = 'portrait') {
  return printableWidthMm(orientation) - ROW_NUMBER_COLUMN_MM;
}

describe('раскладка печати списка', () => {
  it('узкий список печатается книжно, крупным кеглем и без потерь', () => {
    const plan = planListPrintLayout({
      columns: [
        { label: 'Двигатель', valueChars: 8 },
        { label: 'Заказчик', valueChars: 14 },
        { label: 'Дата', valueChars: 10 },
      ],
    });
    expect(plan.orientation).toBe('portrait');
    expect(plan.fontSizePt).toBe(12);
    expect(plan.clippedLabels).toEqual([]);
    expect(sum(plan.widthsMm.slice(1))).toBeLessThanOrEqual(printableWidthMm('portrait') - ROW_NUMBER_COLUMN_MM + 0.01);
  });

  it('первая колонка — «№», её ширина фиксирована', () => {
    const plan = planListPrintLayout({ columns: [{ label: 'Дата', valueChars: 10 }] });
    expect(plan.widthsMm).toHaveLength(2);
    expect(plan.widthsMm[0]).toBe(ROW_NUMBER_COLUMN_MM);
  });

  it('ширины не вылезают за печатную область листа', () => {
    for (const count of [1, 3, 8, 15]) {
      const columns = Array.from({ length: count }, (_, i) => ({ label: `Колонка ${i + 1}`, valueChars: 30 }));
      for (const orientation of ['auto', 'portrait', 'landscape'] as const) {
        const plan = planListPrintLayout({ columns, orientation });
        const available = dataWidth(columns, plan.orientation);
        expect(sum(plan.widthsMm.slice(1)), `${count} колонок, ${orientation}`).toBeLessThanOrEqual(available + 0.01);
        expect(plan.tableWidthMm).toBe(printableWidthMm(plan.orientation));
      }
    }
  });

  it('широкий список поворачивает лист, а не ужимает кегль до нечитаемого', () => {
    const columns = Array.from({ length: 8 }, () => ({ label: 'Наименование', valueChars: 20 }));
    const plan = planListPrintLayout({ columns, orientation: 'auto' });
    expect(plan.orientation).toBe('landscape');
    // Жирная шапка широкая (12 знаков на колонку), поэтому на альбомный лист восемь
    // «Наименований» влезают при 10 pt, а не при 12 — но и не на самом мелком кегле.
    expect(plan.fontSizePt).toBe(10);
    expect(plan.clippedLabels).toEqual([]);
  });

  it('книжная ориентация, выбранная руками, не подменяется альбомной', () => {
    const columns = Array.from({ length: 8 }, () => ({ label: 'Наименование', valueChars: 20 }));
    const plan = planListPrintLayout({ columns, orientation: 'portrait' });
    expect(plan.orientation).toBe('portrait');
    expect(plan.fontSizePt).toBeLessThan(12);
    // Восемь «Наименований» на книжный лист не влезают даже мелким кеглем — планировщик
    // называет потери, а не делает вид, что всё уместилось (лист при этом остаётся книжным).
    expect(plan.clippedLabels.length).toBeGreaterThan(0);
    expect(sum(plan.widthsMm.slice(1))).toBeLessThanOrEqual(dataWidth(columns, 'portrait') + 0.01);
  });

  it('когда не влезает даже 8 pt — называет колонки, которым не хватило места', () => {
    const columns = Array.from({ length: 15 }, (_, i) => ({ label: `Характеристика ${i + 1}`, valueChars: 30 }));
    const plan = planListPrintLayout({ columns, orientation: 'auto' });
    expect(plan.fontSizePt).toBe(Math.min(...PRINT_FONT_STEPS));
    expect(plan.clippedLabels.length).toBeGreaterThan(0);
    expect(plan.clippedLabels.length).toBeLessThanOrEqual(columns.length);
    expect(sum(plan.widthsMm.slice(1))).toBeLessThanOrEqual(dataWidth(columns, plan.orientation) + 0.01);
  });

  it('пустой список колонок даёт колонку «№» и не падает', () => {
    const plan = planListPrintLayout({ columns: [] });
    expect(plan.widthsMm).toEqual([ROW_NUMBER_COLUMN_MM]);
    expect(plan.fontSizePt).toBe(12);
  });

  it('шапка считается жирной: длинному слову заголовка достаётся больше обычного веса', () => {
    // Жирный заголовок шире значений на ~8%: без поправки слово шапки вылезало из колонки
    // на пару пикселей и накладывалось на соседнюю (поймано смоуком на «Номер»).
    const plan = planListPrintLayout({
      columns: [{ label: 'Контрагент', valueChars: 1 }],
      orientation: 'portrait',
      fontSizePt: 12,
    });
    const regularEstimate = 10 * 12 * 0.18 + 4.4;
    expect(plan.widthsMm[1]).toBeGreaterThan(regularEstimate);
    expect(plan.clippedLabels).toEqual([]);
  });

  it('очень длинные значения считаются как потолок, а не растягивают лист', () => {
    const short = planListPrintLayout({ columns: [{ label: 'Комментарий', valueChars: 45 }] });
    const long = planListPrintLayout({ columns: [{ label: 'Комментарий', valueChars: 4000 }] });
    expect(long.widthsMm).toEqual(short.widthsMm);
    expect(long.fontSizePt).toBe(short.fontSizePt);
  });

  it('кегль уменьшается ступенями 12 → 10 → 9 → 8, а не подбирается дробно', () => {
    const columns = Array.from({ length: 6 }, (_, i) => ({ label: `Поле ${i + 1}`, valueChars: 18 }));
    for (const orientation of ['auto', 'portrait', 'landscape'] as const) {
      const plan = planListPrintLayout({ columns, orientation });
      expect(PRINT_FONT_STEPS).toContain(plan.fontSizePt);
    }
  });

  it('прибитый кегль не подменяется: так переключатель в окне предпросмотра пересчитывает ширины', () => {
    const columns = Array.from({ length: 8 }, () => ({ label: 'Наименование', valueChars: 20 }));
    for (const fontSizePt of PRINT_FONT_STEPS) {
      const plan = planListPrintLayout({ columns, orientation: 'landscape', fontSizePt });
      expect(plan.fontSizePt).toBe(fontSizePt);
      expect(plan.orientation).toBe('landscape');
      expect(sum(plan.widthsMm.slice(1))).toBeLessThanOrEqual(dataWidth(columns, 'landscape') + 0.01);
    }
    // Крупный кегль на альбомном листе честно называет то, что перестало влезать, —
    // вместо молчаливой обрезки на печати.
    const big = planListPrintLayout({ columns, orientation: 'landscape', fontSizePt: 12 });
    const small = planListPrintLayout({ columns, orientation: 'landscape', fontSizePt: 8 });
    expect(small.clippedLabels.length).toBeLessThanOrEqual(big.clippedLabels.length);
  });
});

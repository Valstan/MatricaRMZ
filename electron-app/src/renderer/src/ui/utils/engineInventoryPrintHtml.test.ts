import type { EngineInventoryRow } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { buildInventoryDefectBlankHtml, buildInventoryDefectHtml } from './engineInventoryPrintHtml.js';

function row(part_name: string, quantity: number, hasOwnNumber: boolean): EngineInventoryRow {
  const r: EngineInventoryRow = {
    part_name,
    assembly_unit_number: '',
    part_number: '',
    bom_variant_group: null,
    quantity,
    present: true,
    actual_qty: quantity,
    repairable_qty: quantity,
    scrap_qty: 0,
    replace_qty: 0,
    replenishment_branch: null,
    scrap_reason: '',
  };
  // Флаг «у детали может быть свой номер» добавляется в строку списка; читаем его мягко.
  return hasOwnNumber ? ({ ...r, has_own_number: true } as EngineInventoryRow) : r;
}

const ROWS: EngineInventoryRow[] = [
  row('Коленчатый вал', 1, true),
  row('Прокладка ГБЦ', 2, false),
  row('Блок цилиндров', 1, true),
  row('Шайба стопорная', 8, false),
];

function blankHtml(rows: EngineInventoryRow[] = ROWS): string {
  return buildInventoryDefectBlankHtml({
    engineBrand: '6ЧН 21/21',
    engineNumber: 'Д-001',
    engineInternalNumber: '41/26',
    contractNumber: 'ДГ-12',
    rows,
    answers: {},
    blank: true,
  });
}

/** HTML одной строки таблицы — по имени детали в ней. */
function rowHtml(html: string, partName: string): string {
  const chunk = html.split('<tr ').find((s) => s.includes(partName));
  expect(chunk, `строка «${partName}» не найдена`).toBeTruthy();
  return String(chunk).split('</tr>')[0] ?? '';
}

/** Половины бланка — две таблицы рядом. */
function halves(html: string): string[] {
  return html.split('<table class="blank-table">').slice(1);
}

describe('бланк дефектовки — клетка «№ на детали»', () => {
  it('рисует клетку номера только у помеченных деталей', () => {
    const html = blankHtml();
    expect(rowHtml(html, 'Коленчатый вал')).toContain('pn-box');
    expect(rowHtml(html, 'Блок цилиндров')).toContain('pn-box');
    expect(rowHtml(html, 'Прокладка ГБЦ')).not.toContain('pn-box');
    expect(rowHtml(html, 'Шайба стопорная')).not.toContain('pn-box');
  });

  it('строку без номера делает низкой, с номером — выше', () => {
    const html = blankHtml();
    expect(rowHtml(html, 'Коленчатый вал')).toContain('r-num');
    expect(rowHtml(html, 'Прокладка ГБЦ')).toContain('r-plain');
    expect(html).toContain('.blank-table tr.r-plain td { height: 11px; }');
    expect(html).toContain('.blank-table tr.r-num td { height: 18px; }');
  });
});

describe('бланк дефектовки — раскладка в два столбца', () => {
  it('делит список пополам: обе половины содержат строки со сквозной нумерацией', () => {
    const [left, right] = halves(blankHtml());
    expect(halves(blankHtml())).toHaveLength(2);
    expect(left).toContain('Коленчатый вал');
    expect(left).toContain('Прокладка ГБЦ');
    expect(left).not.toContain('Блок цилиндров');
    expect(right).toContain('Блок цилиндров');
    expect(right).toContain('Шайба стопорная');
    expect(rowHtml(String(right), 'Блок цилиндров')).toContain('<td class="idx">3</td>');
  });

  it('добавляет запасные пустые строки в каждый столбец', () => {
    const [left, right] = halves(blankHtml());
    const spare = (s: string) => (s.match(/class="r-num spare"/g) ?? []).length;
    expect(spare(String(left))).toBe(4);
    expect(spare(String(right))).toBe(4);
  });

  it('печатается мелким шрифтом с полями 8 мм — чтобы список влез на один лист', () => {
    const html = blankHtml();
    expect(html).toContain('@page { size: A4; margin: 8mm; }');
    expect(html).toContain('font-size: 9px');
  });

  it('даёт обе таблицы даже на пустом списке — под запись от руки', () => {
    const [left, right] = halves(blankHtml([]));
    expect((String(left).match(/class="r-num spare"/g) ?? []).length).toBe(4);
    expect((String(right).match(/class="r-num spare"/g) ?? []).length).toBe(4);
  });
});

describe('акт дефектовки — подписной документ не затронут', () => {
  it('blank=true уходит в бланк, обычная печать остаётся прежним актом', () => {
    const ctx = {
      engineBrand: '6ЧН 21/21',
      engineNumber: 'Д-001',
      contractNumber: 'ДГ-12',
      rows: ROWS,
      answers: {},
    };
    expect(buildInventoryDefectHtml({ ...ctx, blank: true })).toContain('blank-table');

    const act = buildInventoryDefectHtml(ctx);
    expect(act).not.toContain('blank-table');
    expect(act).toContain('Причина утиля');
    expect(act).toContain('№ сборочной единицы');
  });
});

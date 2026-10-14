import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// B6 (план client-stability-and-ai-2026-10): группировка из отчётов — в списке
// двигателей и списке этапов ремонта. Рвётся молча: список «работает», просто
// снова плоский, или заголовок группы занимает номер строки данных.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const ENGINES = src('../pages/EnginesPage.tsx');
const SHEETS = src('../pages/WorkSheetsPage.tsx');

describe('группировка списка двигателей', () => {
  it('селектор разреза живёт в тулбаре рядом с фильтром', () => {
    expect(ENGINES).toContain('data-engines-group-by');
    expect(ENGINES).toContain('Группировать');
  });

  it('разрезы — те же, что в отчёте «Сейчас на заводе»', () => {
    expect(ENGINES).toContain('engineFactoryStage(e, sheetTypes, stageTemplates)');
    expect(ENGINES).toContain("case 'customer_stage':");
  });

  it('строки раскладывает flattenGrouped, а не плоский массив', () => {
    expect(ENGINES).toContain('flattenGrouped(sorted, groupLevels)');
    expect(ENGINES).toContain('count={groupedItems.length}');
  });

  it('заголовок группы — без чекбокса, без номера и без клика в карточку', () => {
    expect(ENGINES).toContain('data-engine-group={it.key}');
    expect(ENGINES).toContain("return it.kind === 'group' ? null : it.number;");
    expect(ENGINES).toContain("return it.kind === 'group' ? { 'data-engine-group': it.key } : engineRowProps(it.row);");
  });

  it('сгруппированный список — одной колонкой: двухколоночная раскладка группы не раскладывает', () => {
    expect(ENGINES).toContain("{twoCol && groupBy === 'none' ? (");
  });

  it('печать несёт путь заголовков групп, как на экране', () => {
    expect(ENGINES).toContain('rowGroupLabel={(e) => groupLabelByRow.get(String(e.id)) || null}');
  });
});

describe('группировка списка этапов ремонта', () => {
  it('селектор разреза живёт в тулбаре рядом с фильтром', () => {
    expect(SHEETS).toContain('data-work-sheets-group-by');
    expect(SHEETS).toContain('Группировать');
  });

  it('разрезы — те же, что в отчёте «Этапы работ»', () => {
    expect(SHEETS).toContain("case 'customer_type':");
    expect(SHEETS).toContain('flattenGrouped(sorted, groupLevels)');
  });

  it('заголовок группы — без номера, строка данных — со сквозным номером', () => {
    expect(SHEETS).toContain('data-work-sheet-group={it.key}');
    expect(SHEETS).toContain("if (!it || it.kind === 'group') return null;");
    expect(SHEETS).toContain('return it.number;');
  });

  it('печать несёт путь заголовков групп, как на экране', () => {
    expect(SHEETS).toContain('rowGroupLabel={(r) => groupLabelByRow.get(r.id) || null}');
  });
});

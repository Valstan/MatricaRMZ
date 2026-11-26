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
// Разрезы группировки списка двигателей живут в домене (промт КАРМАНА #164): страница и
// сторож читают один список, иначе новый разрез можно добавить «только на экран».
const ENGINE_GROUPING = src('../../../../../../shared/src/domain/engineListGrouping.ts');

describe('группировка списка двигателей', () => {
  it('селектор разреза живёт в тулбаре рядом с фильтром', () => {
    expect(ENGINES).toContain('data-engines-group-by');
    // Владелец 26.10.2026: надпись «Группировать» убрал — селект сам называет разрез
    // («Без группировки», «По этапу на заводе»), смысл остался в подсказке.
    expect(ENGINES).toContain('title="Группировать"');
    expect(ENGINES).not.toContain('<span className="ui-muted">Группировать</span>');
  });

  it('разрезы и их уровни — в домене, страница берёт их оттуда', () => {
    expect(ENGINE_GROUPING).toContain("case 'customer_stage':");
    expect(ENGINE_GROUPING).toContain("case 'customer_contract':");
    expect(ENGINE_GROUPING).toContain('engineFactoryStage(e, deps.sheetTypes, deps.stageTemplates)');
    expect(ENGINES).toContain('engineListGroupLevels(groupBy');
  });

  it('разрез «По договору»: ключ — договор карточки, подпись — номер договора', () => {
    // Промт КАРМАНА #105: группировка по контрактам (договорам) в списке двигателей.
    expect(ENGINE_GROUPING).toContain('contract: \'По договору\'');
    expect(ENGINE_GROUPING).toContain("const id = String(e.contractId ?? '').trim();");
    expect(ENGINE_GROUPING).toContain("const label = String(e.contractName ?? '').trim();");
  });

  it('двигатель без договора — отдельная группа «Без договора»', () => {
    expect(ENGINE_GROUPING).toContain("label: label || 'Без договора'");
  });

  it('комбинация «Заказчик → договор» — тем же приёмом, что «Заказчик → этап»', () => {
    expect(ENGINE_GROUPING).toContain('customer_contract: \'Заказчик → договор\'');
    expect(ENGINE_GROUPING).toContain('return [byCustomer, byContract];');
  });

  it('строки раскладывает flattenGrouped, а не плоский массив', () => {
    expect(ENGINES).toContain('flattenGrouped(sorted, groupLevels)');
    expect(ENGINES).toContain('count={groupedItems.length}');
  });

  it('заголовок группы — без чекбокса, без номера и без клика в карточку', () => {
    expect(ENGINES).toContain('data-engine-group={it.key}');
    expect(ENGINES).toContain("return it.kind === 'group' ? { 'data-engine-group': it.key } : engineRowProps(it.row);");
    // Заголовок группы занимает всю ширину строки — вместе с колонками-номерами.
    expect(ENGINES).toContain('colSpan={visibleColumns.length + 1 + numberColumnCount}');
  });

  it('нумерации — обычные колонки списка: обе видны в «Колонках списка» и обе отключаются', () => {
    expect(ENGINES).toContain('LIST_NUMBER_COLUMN_IDS');
    expect(ENGINES).toContain("columnLayout.isVisible('rowNumber')");
    expect(ENGINES).toContain("columnLayout.isVisible('groupNumber')");
  });

  it('сгруппированный список — одной колонкой: двухколоночная раскладка группы не раскладывает', () => {
    expect(ENGINES).toContain("{twoCol && groupBy === 'none' ? (");
  });

  it('печать и выгрузка получают тот же сгруппированный ряд, что и экран', () => {
    // Промт КАРМАНА #164: разрез «Заказчик → договор» жил только на экране — печать,
    // выгрузка и меню получали плоский отсортированный список. Сторож ловит именно эту
    // подмену: печать и выгрузка обязаны получать РЯД группировки, а не плоский список.
    const seriesUsages = ENGINES.match(/series=\{groupedItems\}/g) ?? [];
    expect(seriesUsages.length, 'печать и выгрузка получают сгруппированный ряд').toBeGreaterThanOrEqual(2);
    expect(ENGINES).not.toContain('rowGroupLabel={(e) =>');
  });

  it('печать и копирование из контекстного меню знают про группировку', () => {
    expect(ENGINES).toContain('listPrintAction<EngineListItem>');
    expect(ENGINES).toContain('listCopyAction<EngineListItem>');
    expect(ENGINES).toContain('filterPrintItemsBySelection(groupedItems, rows)');
  });
});

describe('группировка списка этапов ремонта', () => {
  it('селектор разреза живёт в тулбаре рядом с фильтром', () => {
    expect(SHEETS).toContain('data-work-sheets-group-by');
    expect(SHEETS).toContain('title="Группировать"');
    expect(SHEETS).not.toContain('<span className="ui-muted">Группировать</span>');
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

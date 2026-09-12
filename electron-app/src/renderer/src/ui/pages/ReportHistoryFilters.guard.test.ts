import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Владелец 12.09.2026: «хотим возобновить отчёт, которым пользовались недавно, и не помним,
// какой это был отчёт и какие настройки в нём выставляли». Цепочка длинная и рвётся молча в
// каждом звене: страница может перестать писать настройки в журнал, каталог — перестать их
// показывать, App — не донести их до страницы, а предзаполнение популярными затрёт то, что
// оператор только что выбрал. Сторож держит все четыре звена.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PRESET_PAGE = src('./ReportPresetPage.tsx');
const CATALOG = src('./ReportsCatalogPage.tsx');
const APP = src('../App.tsx');
const MAIN_IPC = src('../../../../main/ipc/register/reports.ts');

describe('журнал отчётов помнит настройки', () => {
  it('страница отчёта пишет в журнал фильтры, выключенные фильтры и число строк', () => {
    const append = PRESET_PAGE.slice(PRESET_PAGE.indexOf('async function appendHistory'), PRESET_PAGE.indexOf('async function buildPreview'));
    expect(append).toContain('filters: requestFilters as Record<string, unknown>');
    expect(append).toContain('disabled: [...activeDisabled]');
    expect(append).toContain('rowCount: report.rows.length');
  });

  it('main сохраняет настройки и схлопывает повторы по набору, а не по времени', () => {
    expect(MAIN_IPC).toContain('reportHistorySignature');
    expect(MAIN_IPC, 'потолок на объём настроек обязателен — журнал не должен пухнуть').toContain('HISTORY_FILTERS_JSON_LIMIT');
    expect(MAIN_IPC, 'старое схлопывание «пресет + время» плодило бы одинаковые строки').not.toContain('`${row.presetId}::${row.generatedAt}`');
  });

  it('счётчик повторов растёт на одно построение, а чтение блоба его не удваивает', () => {
    // Санитайзер берёт максимум (он лишь убирает дубли), наращивает только точка записи.
    expect(MAIN_IPC).toContain('const merged = Math.max(prev.times ?? 1, row.times ?? 1);');
    expect(MAIN_IPC).toContain('...(prev ? { times: (prev.times ?? 1) + 1 } : {}),');
  });

  it('журнал роумится своей секцией профиля', () => {
    expect(APP).toContain('snapshot.reportHistory = reportHistorySnap');
    expect(APP).toContain('historyMerge(');
    expect(MAIN_IPC).toContain("ipcMain.handle('reports:historyMerge'");
  });
});

describe('повтор отчёта из журнала', () => {
  it('каталог показывает настройки словами и открывает отчёт с ними', () => {
    expect(CATALOG).toContain('formatReportFiltersSummary');
    expect(CATALOG).toContain('data-report-history-row');
    expect(CATALOG).toContain('filters: entry.filters ?? null');
    expect(CATALOG, 'идентификаторы заменяются именами из вариантов фильтров').toContain('optionSets');
  });

  it('часто повторяемые наборы — тот же журнал, отсортированный по числу построений', () => {
    expect(CATALOG).toContain('Часто повторяемые отчёты');
    expect(CATALOG).toContain('Number(entry.times ?? 0) > 1');
  });

  it('App доносит настройки до страницы отчёта в обеих точках отрисовки', () => {
    expect(APP).toContain('function initialFiltersFor(presetId: ReportPresetId)');
    expect((APP.match(/initialFilters=\{initialFiltersFor\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(APP, 'обычное открытие гасит прежний набор, иначе он унаследуется молча').toContain('setReportPresetInitialFilters(');
  });

  it('предзаполнение популярными не затирает переданный набор', () => {
    expect(PRESET_PAGE).toContain('if (props.initialFilters && props.initialFilters.filters) return;');
    expect(PRESET_PAGE).toContain('initialAppliedRef');
  });
});

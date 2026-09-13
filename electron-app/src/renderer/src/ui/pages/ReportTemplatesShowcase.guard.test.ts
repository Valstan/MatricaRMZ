import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Витрина заготовок (этап 2B) сводит три РАЗНЫХ хранилища — шаблоны фильтров всех пресетов,
// журнал построений и «Мои отчёты» — и каждое звено рвётся молча: страница может перестать
// звать какой-то из источников, App — не довезти настройки до отчёта, конструктор — открыться
// пустым вместо выбранного шаблона. Экран при этом останется на месте и будет выглядеть живым,
// просто наполовину пустым, а это ровно то, за чем оператор сюда и приходит.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const SHOWCASE = src('./ReportTemplatesShowcasePage.tsx');
const PRESET_PAGE = src('./ReportPresetPage.tsx');
const CUSTOM = src('./CustomReportsPage.tsx');
const APP = src('../App.tsx');
const MAIN_IPC = src('../../../../main/ipc/register/reports.ts');

describe('витрина собирает все три источника', () => {
  it('читает шаблоны всех пресетов, журнал и «Мои отчёты» — своего хранилища не заводит', () => {
    expect(SHOWCASE, 'шаблоны всех пресетов разом, а не по одному').toContain('filterTemplatesExportAll(');
    expect(SHOWCASE).toContain('historyList(');
    expect(SHOWCASE).toContain('customTemplatesList(');
    expect(SHOWCASE, 'варианты фильтров нужны, чтобы показать настройки именами').toContain('presetList()');
  });

  it('настройки показываются словами, а не идентификаторами', () => {
    expect(SHOWCASE).toContain('formatReportFiltersSummary');
    expect(SHOWCASE).toContain('optionSets');
  });

  it('шаблон и строка журнала с тем же набором не двоятся', () => {
    // Подпись набора — единственное, что связывает сохранённый шаблон со строкой журнала;
    // без неё один и тот же отбор показался бы двумя карточками, а у шаблона не было бы
    // «строили N раз».
    expect(SHOWCASE).toContain('reportHistorySignature');
    expect(SHOWCASE).toContain('claimedSignatures');
  });

  it('витрина не устаревает молча, пока её держат открытой рядом', () => {
    expect(SHOWCASE).toContain("'matrica:report-history-changed'");
    expect(SHOWCASE).toContain("'matrica:report-templates-changed'");
  });

  it('сортировка по частоте и по свежести, поиск по описанию', () => {
    expect(SHOWCASE).toContain("'frequent'");
    expect(SHOWCASE).toContain('b.times - a.times');
    expect(SHOWCASE).toContain('data-report-showcase-search');
  });
});

describe('открытие из витрины', () => {
  it('пресет открывается уже настроенным — той же точкой, что журнал', () => {
    expect(SHOWCASE).toContain('props.onOpenPreset(');
    expect(SHOWCASE).toContain('filters: tpl.filters ?? null');
    expect(SHOWCASE).toContain('filters: entry.filters ?? null');
  });

  it('App отдаёт витрине обе двери: пресет с настройками и конструктор на шаблоне', () => {
    expect(APP).toContain('ReportTemplatesShowcasePage');
    expect(APP).toContain('setCustomReportInitialTemplateId(');
    expect(APP).toContain('initialTemplateId={customReportInitialTemplateId}');
  });

  it('конструктор применяет выбранный шаблон один раз, не затирая правки оператора', () => {
    expect(CUSTOM).toContain('appliedInitialRef');
    expect(CUSTOM).toContain('props.initialTemplateId');
  });
});

describe('описание у шаблона фильтров', () => {
  it('поле доезжает от карточки отчёта до хранилища', () => {
    expect(PRESET_PAGE).toContain('data-report-template-description');
    expect(PRESET_PAGE).toContain('templateDescription');
    expect(PRESET_PAGE, 'пустое описание не пишем — иначе у шаблона появится пустая строка').toContain(
      "...(templateDescription.trim() ? { description: templateDescription.trim() } : {})",
    );
    expect(MAIN_IPC).toContain('FILTER_TEMPLATE_DESCRIPTION_LIMIT');
  });

  it('применение шаблона подставляет и его описание', () => {
    expect(PRESET_PAGE).toContain('setTemplateDescription(tpl.description ?? \'\')');
  });

  it('витрина показывает подпись владельца отдельно от перечня настроек', () => {
    expect(SHOWCASE).toContain('data-report-showcase-description');
    expect(SHOWCASE).toContain('tpl.description ?? \'\'');
  });
});

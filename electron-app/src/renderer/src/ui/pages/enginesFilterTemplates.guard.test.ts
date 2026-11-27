import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Промт КАРМАНА #181: шаблоны фильтров для списка двигателей.
//
// Механика сохранения шаблонов в программе уже была — для отчётов по пресетам: именованные
// шаблоны хранятся в профиле пользователя, едут за оператором на другой компьютер и хранят
// значения фильтров и перечень отключённых фильтров. Список двигателей берёт ТОТ ЖЕ
// механизм, а не новую сущность. Сторож стоит на свойствах: шаблон есть, он сохраняется
// тем же IPC, едет в профиль и НЕ тащит выбранного заказчика и договор.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EnginesPage.tsx');
const MAIN = src('../../../../main/ipc/register/reports.ts');
const HOOK = src('../hooks/useListFilterTemplates.ts');
const SHARED_TEMPLATES = src('../../../../../../shared/src/domain/engineListFilterTemplates.ts');
const SHARED_REPORTS = src('../../../../../../shared/src/domain/reports.ts');
const SHARED_PROFILE = src('../../../../../../shared/src/domain/userUiProfile.ts');

describe('шаблоны фильтров списка двигателей (промт КАРМАНА #181)', () => {
  it('в списке есть выбор шаблона и «сохранить как шаблон»', () => {
    expect(PAGE, 'нет выбора шаблона').toContain('data-engine-filter-template');
    expect(PAGE, 'нет поля названия шаблона').toContain('data-engine-filter-template-name');
    expect(PAGE, 'нет кнопки сохранения шаблона').toContain('data-engine-filter-template-save');
    expect(PAGE, 'нет удаления шаблона').toContain('data-engine-filter-template-delete');
  });

  it('шаблон сохраняется тем же IPC, что у отчётов, — своим ключом списка', () => {
    expect(HOOK).toContain("window.matrica.reports.filterTemplateSave(");
    expect(HOOK).toContain("window.matrica.reports.filterTemplatesList(");
    expect(HOOK).toContain("window.matrica.reports.filterTemplateDelete(");
    expect(PAGE, 'ключ шаблона списка не тот').toContain("key: 'list:engines'");
    // Ключ списка — в общем реестре шаблонов, а не новая сущность.
    expect(SHARED_REPORTS).toContain("export const LIST_FILTER_TEMPLATE_KEYS = ['list:engines'] as const;");
    expect(MAIN, 'ключ списка не проходит дверь шаблонов').toContain('const VALID_FILTER_TEMPLATE_KEYS = new Set<string>([...VALID_PRESET_IDS, ...LIST_FILTER_TEMPLATE_KEYS]);');
  });

  it('шаблон едет в профиль: выгрузка и вливание берут ключи шаблонов, а не только пресеты', () => {
    // Роуминг шаблонов идёт через ui_profile (секция reportFilterTemplates). Если ключ
    // списка отрежется на выгрузке, шаблоны не переживут другой компьютер.
    expect(MAIN).toContain('resolveFilterTemplateKey(presetKeyRaw)');
    expect(MAIN).toContain('resolveFilterTemplateKey(String(presetKeyRaw))');
    expect(MAIN).toContain('VALID_FILTER_TEMPLATE_KEYS.has(presetKey)');
    // Санитайзер секции профиля не должен выбрасывать перечень включённых ступеней.
    expect(SHARED_PROFILE).toContain('const enabled = Array.isArray(r.enabled)');
  });

  it('в шаблон не попадает выбранный заказчик и договор — это правило в домене', () => {
    expect(SHARED_TEMPLATES).toContain("export const ENGINE_LIST_TEMPLATE_EXCLUDED_FACETS = ['customer', 'contract'] as const;");
    expect(SHARED_TEMPLATES).toContain('if (isTemplateExcludedFacet(facetId)) continue;');
    // Страница собирает шаблон общим сборщиком, а не своей копией правила.
    expect(PAGE).toContain('buildEngineListTemplatePayload(');
    expect(PAGE).toContain('applyEngineListTemplatePayload(');
  });

  it('применение шаблона не трогает сортировку и видимость колонок', () => {
    const apply = PAGE.slice(PAGE.indexOf('const applyFilterTemplate ='), PAGE.indexOf('const applyFilterTemplate =') + 1600);
    expect(apply).toContain('patchState({');
    expect(apply, 'шаблон сортирует список — обстановка оператора поехала').not.toContain('sortKey');
    expect(apply, 'шаблон меняет колонки — обстановка оператора поехала').not.toContain('columnLayout');
    expect(apply, 'шаблон не открывает нужные ступени — отбор не видно').toContain('facetFields:');
  });

  it('после применения заказчик и договор пусты', () => {
    const apply = PAGE.slice(PAGE.indexOf('const applyFilterTemplate ='), PAGE.indexOf('const applyFilterTemplate =') + 1600);
    expect(apply, 'старый фильтр заказчика остался — после шаблона он не пуст').toContain("customerFilter: ''");
  });
});

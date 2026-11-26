import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SEARCH_FIELDS } from '@matricarmz/shared';

// Промт КАРМАНА #138 (25.11.2026): рядом со строкой поиска — кнопка выбора, ГДЕ искать.
// Выбранное поле сужает выдачу: остаются только совпадения ПО НЕМУ.
//
// Ломается всё это молча:
//  * кнопка без DOM-метки уезжает в меню «⋯» или ломается на Fast Refresh (M120);
//  * выбор поля, сохранённый в состоянии списка, переезжает на другой список — поля там
//    другие, и выдача молча пустеет (оператор решит, что поиск сломан);
//  * выбор поля, который ломает режим «точный / ≈ Похожие», — это уже не «сужение»,
//    а смена правил поиска;
//  * суженная выдача без видимой подписи выбранного поля читается как «пропали совпадения».
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PICKER = src('../components/SearchFieldPicker.tsx');
const TOOLBAR = src('../components/ToolbarSearchField.tsx');
const FIELD_HOOK = src('../hooks/useSearchField.ts');
const PALETTE = src('../components/GlobalSearchOverlay.tsx');
const ENGINES = src('../pages/EnginesPage.tsx');
const CONTRACTS = src('../pages/ContractsPage.tsx');
const SEARCH = src('../utils/search.ts');
const DEEP_FILTER = src('../hooks/useListDeepFilter.ts');
const BACKEND_ROUTE = src('../../../../../../backend-api/src/routes/search.ts');

/** Списки, в которых кнопка «где искать» уже включена. */
const PICKER_SCREENS: Array<[string, string]> = [
  ['EnginesPage', ENGINES],
  ['ContractsPage', CONTRACTS],
];

/** Ключи типа строки из исходника страницы. */
function typeKeys(source: string, marker: string): Set<string> {
  const start = source.indexOf(marker);
  expect(start, `не найден блок «${marker}»`).toBeGreaterThan(-1);
  const end = source.indexOf('\n};', start);
  const block = source.slice(start, end === -1 ? undefined : end);
  const keys = new Set<string>();
  for (const match of block.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)) keys.add(match[1]!);
  return keys;
}

/** Форма строки справочника (`EntityListItem`) — из неё берутся L2-источники палитры. */
const DIRECTORY_ROW_KEYS = new Set(['id', 'typeId', 'updatedAt', 'syncStatus', 'displayName', 'searchText', 'price']);

describe('кнопка «где искать»', () => {
  it('у кнопки есть DOM-метка — иначе она уедет в меню или сломается на Fast Refresh', () => {
    expect(PICKER).toContain('data-search-field="button"');
    expect(PICKER).toContain('data-search-field-option="all"');
    // Признак «не убирать из меню» ставится РАЗМЕТКОЙ (`data-toolbar-pin`), а не
    // сравнением типа компонента (M120).
    expect(src('../components/PageToolbar.tsx')).toContain('data-toolbar-pin');
  });

  it('кнопка живёт в общей панели, а не отдельным полем рядом', () => {
    // Поле и кнопка — одна обёртка в ряду кнопок списка.
    expect(TOOLBAR).toContain('<SearchFieldPicker');
    expect(TOOLBAR).toContain('fieldOptions');
    // Своё поле поиска в тулбаре у списков не появляется (гейт ListChrome).
    expect(TOOLBAR).not.toMatch(/<Input[^>]*placeholder="Поиск/);
  });

  it('по умолчанию — «искать везде», и сброс в него — одним кликом', () => {
    expect(PICKER).toContain("export const SEARCH_FIELD_EVERYWHERE = 'Искать везде';");
    expect(PICKER).toContain('data-search-field-option="all"');
  });

  it('выбранное поле видно на кнопке — иначе «пропавшие» совпадения читаются как поломка', () => {
    expect(PICKER).toContain('По ${chosen.title}');
    expect(PALETTE).toContain('SEARCH_FIELD_NARROWED_NOTE');
  });
});

describe('выбор поля — независимый переключатель', () => {
  it('живёт в своём хуке, а не в состоянии списка (тот лежит в sessionStorage)', () => {
    expect(FIELD_HOOK).toContain('export function useSearchField');
    for (const [name, code] of PICKER_SCREENS) {
      expect(code, `${name}: выбор поля попал в состояние списка`).not.toMatch(/listState\.(field|fieldChoice|searchField)/);
      expect(code, `${name}: выбор поля не взят из общего хука`).toContain('useSearchField(');
    }
  });

  it('не переживает перезапуск списка и очистку поля — как режим поиска', () => {
    expect(FIELD_HOOK).toContain('useOnTabVisible(() => setChoice(null));');
    expect(FIELD_HOOK).toContain('if (!query.trim()) setChoice(null);');
  });

  it('не ломает режим «точный / ≈ Похожие» и наоборот', () => {
    // Кнопка выбора поля не трогает режим: у неё нет ни `similar`, ни `searchModeOf`.
    expect(PICKER).not.toContain('similar');
    expect(PICKER).not.toContain('searchModeOf');
    // А режим выдачу не сужает: сужает только поле.
    expect(SEARCH).toContain("mode: SearchMode = 'exact'");
  });

  it('поле другой сущности не применяется — иначе выдача молча пустеет', () => {
    expect(FIELD_HOOK).toContain('choice.kind === kind');
  });
});

describe('сужение выдачи по полю', () => {
  it('сужает по ТОМУ ЖЕ полю, по которому ищет', () => {
    expect(SEARCH).toContain('filterRowsBySearchField');
    expect(SEARCH).toContain("opts?: { fieldId?: string }");
    expect(SEARCH).toContain('export function matchesQueryInSearchField');
  });

  it('глубокий поиск внутри карточек при выбранном поле выключен — поле совпадения он не называет', () => {
    expect(DEEP_FILTER).toContain('entityBacked && !fieldId');
    expect(DEEP_FILTER).toContain('if (fieldId) {');
  });

  it('экраны с кнопкой действительно сужают выдачу', () => {
    expect(ENGINES).toContain('fieldId');
    expect(ENGINES).toContain('...(fieldId ? { fieldId } : {})');
    expect(CONTRACTS).toContain("matchesQueryInSearchField(query, row, 'contract', fieldId, searchMode)");
  });

  it('кнопка предлагает поля, которые в строке ЕСТЬ — иначе выбор даст пустую выдачу', () => {
    // Реестр описывает сущность вообще; список спрашивает, какие поля в его строках есть.
    expect(ENGINES).toContain("searchFieldOptionsForRows('engine'");
    expect(CONTRACTS).toContain("searchFieldOptionsForRows('contract'");
  });

  it('каждое поле реестра контракта достижимо в строке списка или справочника', () => {
    const contractRowKeys = typeKeys(CONTRACTS, 'type Row = {');
    for (const field of SEARCH_FIELDS.contract ?? []) {
      const reachable = field.keys.some((key) => contractRowKeys.has(key) || DIRECTORY_ROW_KEYS.has(key));
      expect(reachable, `поле «${field.title}» (${field.id}) есть ни в строке списка, ни в справочнике`).toBe(true);
    }
  });

  it('у двигателя в реестре есть те поля, что в строке двигателя', () => {
    const engineRowKeys = typeKeys(src('../../../../../../shared/src/ipc/types.ts'), 'export type EngineListItem = {');
    for (const field of SEARCH_FIELDS.engine ?? []) {
      const reachable = field.keys.some((key) => engineRowKeys.has(key));
      expect(reachable, `поле «${field.title}» (${field.id}) есть не в строке двигателя`).toBe(true);
    }
  });

  it('палитра сужает до своей сущности и выключает слои, которые поля не знают', () => {
    expect(PALETTE).toContain('scope.kind === chosenKind');
    expect(PALETTE).toContain('if (chosenKind && src.kind !== chosenKind) continue;');
    // Серверный слой (L3) и deep (L2.5) при сужении выключены — и сказано об этом.
    expect(PALETTE).toContain('if (showL3 && !chosenKind) out.push(...serverHits);');
    expect(PALETTE).toContain('if (deepIds.size === 0 || fieldChoice) return [];');
    // Серверная сторона это знает и говорит то же самое.
    expect(BACKEND_ROUTE).toContain('назвать поле совпадения он НЕ умеет');
  });

  it('уровень поиска и выбор поля — разные переключатели, и не слились', () => {
    // Уровни («Авто / Эта страница / Справочники / Сервер») отвечают «откуда смотреть».
    expect(PALETTE).toContain("const LEVELS: Array<{ mode: LevelMode; label: string }>");
    expect(PALETTE).toContain("const [fieldChoice, setFieldChoice] = useState<SearchFieldChoice | null>(null);");
  });
});

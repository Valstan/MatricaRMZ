import { describe, expect, it } from 'vitest';

import {
  FILE_SEARCH_ENGINE_SUGGEST_MAX_LIMIT,
  fileSearchEngineNumberMatchKind,
  fileSearchEngineQueryDigits,
  fileSearchEngineSuggestFooter,
  isFileSearchEngineNumberLike,
  rankAllFileSearchEngineSuggestions,
  rankFileSearchEngineSuggestions,
  type FileSearchEngineSuggestion,
} from './fileSearchEngineSuggest.js';

const CANDIDATES: FileSearchEngineSuggestion[] = [
  { id: 'e-suffix', engineNumber: 'Э06АТ0889' },
  { id: 'e-exact', engineNumber: '0889' },
  { id: 'e-substring', engineNumber: 'Э06АТ0889-12' },
  { id: 'e-other', engineNumber: 'Э06АТ0777' },
];

describe('«похоже на номер»', () => {
  it('цифры — да, начиная с четырёх', () => {
    expect(isFileSearchEngineNumberLike('0889')).toBe(true);
    expect(isFileSearchEngineNumberLike('088')).toBe(false);
    expect(isFileSearchEngineNumberLike('08890')).toBe(true);
  });

  it('разделители внутри номера допустимы', () => {
    expect(isFileSearchEngineNumberLike('41/26')).toBe(true);
    expect(isFileSearchEngineNumberLike('41-26')).toBe(true);
    expect(isFileSearchEngineNumberLike('  0889 ')).toBe(true);
  });

  it('слово подсказками не считается — иначе они мешали бы искать по содержимому', () => {
    expect(isFileSearchEngineNumberLike('акт')).toBe(false);
    expect(isFileSearchEngineNumberLike('приёмка')).toBe(false);
    expect(isFileSearchEngineNumberLike('Э06АТ0889')).toBe(false);
    expect(isFileSearchEngineNumberLike('')).toBe(false);
  });

  it('цифры запроса достаются без разделителей', () => {
    expect(fileSearchEngineQueryDigits('41/26')).toBe('4126');
    expect(fileSearchEngineQueryDigits(' 0889 ')).toBe('0889');
  });
});

describe('вид совпадения номера', () => {
  it('точное — набранное равно номеру', () => {
    expect(fileSearchEngineNumberMatchKind('0889', '0889')).toBe('exact');
  });

  it('суффикс — номер заканчивается набранным', () => {
    expect(fileSearchEngineNumberMatchKind('Э06АТ0889', '0889')).toBe('suffix');
  });

  it('вхождение внутрь номера — самое общее', () => {
    expect(fileSearchEngineNumberMatchKind('Э06АТ0889-12', '0889')).toBe('substring');
  });

  it('несовпадение — никакого вида', () => {
    expect(fileSearchEngineNumberMatchKind('Э06АТ0777', '0889')).toBeNull();
    expect(fileSearchEngineNumberMatchKind('', '0889')).toBeNull();
    expect(fileSearchEngineNumberMatchKind('Э06АТ0889', '')).toBeNull();
  });
});

describe('порядок подсказок', () => {
  it('«0889» даёт: точное → суффикс → вхождение', () => {
    const ranked = rankFileSearchEngineSuggestions(CANDIDATES, '0889');
    expect(ranked.map((s) => s.id)).toEqual(['e-exact', 'e-suffix', 'e-substring']);
  });

  it('несовпавшие номера в выдачу не попадают', () => {
    const ranked = rankFileSearchEngineSuggestions(CANDIDATES, '0889');
    expect(ranked.some((s) => s.engineNumber === 'Э06АТ0777')).toBe(false);
  });

  it('пустой запрос — пустая выдача', () => {
    expect(rankFileSearchEngineSuggestions(CANDIDATES, '')).toEqual([]);
    expect(rankFileSearchEngineSuggestions(CANDIDATES, '   ')).toEqual([]);
  });

  it('лимит ограничивает выдачу, но не больше потолка', () => {
    expect(rankFileSearchEngineSuggestions(CANDIDATES, '0889', 1)).toHaveLength(1);
    expect(rankFileSearchEngineSuggestions(CANDIDATES, '0889', 999)).toHaveLength(3);
    expect(FILE_SEARCH_ENGINE_SUGGEST_MAX_LIMIT).toBe(20);
  });
});

describe('вся выдача без потолка', () => {
  const MANY: FileSearchEngineSuggestion[] = Array.from({ length: 25 }, (_, i) => ({
    id: `e-${i}`,
    engineNumber: `Э06АТ0889-${i}`,
  }));

  it('не режет — из неё и лимит, и «сколько всего нашлось»', () => {
    expect(rankAllFileSearchEngineSuggestions(MANY, '0889')).toHaveLength(25);
  });

  it('порядок тот же: точное → суффикс → вхождение', () => {
    const ranked = rankAllFileSearchEngineSuggestions(CANDIDATES, '0889');
    expect(ranked.map((s) => s.id)).toEqual(['e-exact', 'e-suffix', 'e-substring']);
  });

  it('пустой запрос — пустая выдача', () => {
    expect(rankAllFileSearchEngineSuggestions(MANY, '')).toEqual([]);
  });
});

describe('подвал выпадашки подсказок', () => {
  it('показывать нечего — подвала нет', () => {
    expect(fileSearchEngineSuggestFooter({ total: 0, loaded: 0 }).kind).toBe('none');
    expect(fileSearchEngineSuggestFooter({ total: 3, loaded: 3 }).kind).toBe('none');
  });

  it('нашлось больше, чем показано, — кнопка «показать ещё»', () => {
    const footer = fileSearchEngineSuggestFooter({ total: 20, loaded: 12 });
    expect(footer.kind).toBe('more');
    expect(footer.kind === 'more' ? footer.label : '').toBe('Показать ещё 8');
  });

  it('дошли до потолка, а совпадений больше — честная заметка', () => {
    const footer = fileSearchEngineSuggestFooter({ total: 27, loaded: 20 });
    expect(footer.kind).toBe('capped');
    expect(footer.kind === 'capped' ? footer.label : '').toBe('Показаны первые 20 из 27');
  });

  it('потолок подсказок — 20', () => {
    const footer = fileSearchEngineSuggestFooter({ total: 100, loaded: 12 });
    expect(footer.kind === 'more' ? footer.label : '').toBe('Показать ещё 8');
  });
});

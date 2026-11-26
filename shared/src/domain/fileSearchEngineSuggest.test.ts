import { describe, expect, it } from 'vitest';

import {
  FILE_SEARCH_ENGINE_SUGGEST_MAX_LIMIT,
  fileSearchEngineNumberMatchKind,
  fileSearchEngineQueryDigits,
  isFileSearchEngineNumberLike,
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

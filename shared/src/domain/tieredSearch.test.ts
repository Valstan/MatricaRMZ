import { describe, expect, it } from 'vitest';

import {
  buildLookupHighlightParts,
  damerauLevenshtein,
  keyboardLayoutVariants,
  prepareLookupOptions,
  rankLookupOptions,
  rankPreparedLookupOptions,
  searchLookupOptionsTiered,
  searchPreparedLookupOptionsTiered,
} from './tieredSearch.js';

describe('tieredSearch (tiers 1-2, moved from electron searchMatching)', () => {
  it('finds options by secondary search fields', () => {
    const options = [
      { id: 'contract-1', label: 'Контракт А', hintText: 'Внутр. 17', searchText: 'Внутренний 17 ООО Ромашка' },
      { id: 'contract-2', label: 'Контракт Б', hintText: 'Внутр. 42', searchText: 'Внутренний 42 АО Вектор' },
    ];
    const result = rankLookupOptions(options, 'вектор 42');
    expect(result[0]?.id).toBe('contract-2');
  });

  it('matches compact numbers across separators (240-1 ≡ 2401)', () => {
    const options = [
      { id: 'a', label: 'Деталь 240-1' },
      { id: 'b', label: 'Деталь 999' },
    ];
    expect(rankLookupOptions(options, '2401')[0]?.id).toBe('a');
  });

  it('highlights matching fragments in helper text', () => {
    const parts = buildLookupHighlightParts('ИНН 7701234567', '7701');
    expect(parts.some((part) => part.matched && part.text === '7701')).toBe(true);
  });
});

describe('keyboard layout correction', () => {
  it('produces RU variant for EN-typed query and vice versa', () => {
    expect(keyboardLayoutVariants('ldbufntkm')).toContain('двигатель');
    expect(keyboardLayoutVariants('игдфе')).toContain('bulat');
  });

  it('ranks options for a query typed in the wrong layout', () => {
    const options = [
      { id: 'engine', label: 'Двигатель В-46' },
      { id: 'other', label: 'Насос НШ-32' },
    ];
    // "ldbufntkm" = "двигатель" typed with EN layout active
    const result = rankLookupOptions(options, 'ldbufntkm');
    expect(result[0]?.id).toBe('engine');
    expect(result).toHaveLength(1);
  });

  it('direct match outranks layout-converted match', () => {
    const options = [
      { id: 'lat', label: 'ldb сервис' },
      { id: 'ru', label: 'дви сервис' },
    ];
    const result = rankLookupOptions(options, 'ldb');
    expect(result[0]?.id).toBe('lat');
  });

  it('highlights fragments matched via converted layout', () => {
    const parts = buildLookupHighlightParts('Двигатель В-46', 'ldbufntkm');
    expect(parts.some((p) => p.matched && p.text.toLowerCase() === 'двигатель')).toBe(true);
  });
});

describe('damerauLevenshtein', () => {
  it('counts substitution, insertion, deletion, transposition as 1', () => {
    expect(damerauLevenshtein('кот', 'код', 2)).toBe(1);
    expect(damerauLevenshtein('кот', 'крот', 2)).toBe(1);
    expect(damerauLevenshtein('крот', 'кот', 2)).toBe(1);
    expect(damerauLevenshtein('весна', 'венса', 2)).toBe(1);
  });

  it('early-exits past the budget', () => {
    expect(damerauLevenshtein('абвгд', 'xyzqw', 2)).toBe(3);
  });
});

describe('list-filter mode (minScore floor)', () => {
  it('does not admit partial-token matches in filter mode, falls back to fuzzy', async () => {
    const { prepareLookupOptions, searchPreparedLookupOptionsTiered, LOOKUP_FILTER_MIN_SCORE } = await import('./tieredSearch.js');
    const longRecord = 'двигатель контракт 12345 заказчик ООО Ромашка статус ремонт начат';
    const prepared = prepareLookupOptions([{ id: 'e1', label: 'TEST-001', searchText: longRecord }]);
    // «text-001» shares only the token «001» with the record — must NOT pass
    // the filter floor as a primary hit; it is a typo and belongs to similar.
    const r = searchPreparedLookupOptionsTiered(prepared, 'text-001', { minScore: LOOKUP_FILTER_MIN_SCORE });
    expect(r.primary).toHaveLength(0);
    expect(r.similar.map((o) => o.id)).toEqual(['e1']);
  });

  it('subsequence does not fire on long haystacks', () => {
    const longRecord = 'абв '.repeat(40);
    const r = rankLookupOptions([{ id: 'x', label: 'Запись', searchText: longRecord }], 'звс');
    expect(r).toHaveLength(0);
  });
});

describe('searchLookupOptionsTiered (tier 3 — «похожие»)', () => {
  const options = [
    { id: 'v46', label: 'Двигатель В-46-2С1' },
    { id: 'v84', label: 'Двигатель В-84 МБ' },
    { id: 'pump', label: 'Насос водяной' },
  ];

  it('keeps similar empty when primary has hits', () => {
    const r = searchLookupOptionsTiered(options, 'двигатель');
    expect(r.primary.length).toBeGreaterThan(0);
    expect(r.similar).toHaveLength(0);
  });

  it('falls back to fuzzy on a typo (двигтаель -> двигатель)', () => {
    const r = searchLookupOptionsTiered(options, 'двигтаель');
    expect(r.primary).toHaveLength(0);
    expect(r.similar.map((o) => o.id)).toEqual(expect.arrayContaining(['v46', 'v84']));
    expect(r.similar.map((o) => o.id)).not.toContain('pump');
  });

  it('matches a typo in a short token within budget 1 (насас -> насос)', () => {
    const r = searchLookupOptionsTiered(options, 'насас');
    expect(r.similar.map((o) => o.id)).toEqual(['pump']);
  });

  it('does not fuzzy-match tokens shorter than 3 chars', () => {
    const r = searchLookupOptionsTiered(options, 'хх');
    expect(r.primary).toHaveLength(0);
    expect(r.similar).toHaveLength(0);
  });
});

// Режимы поиска в списках (просьба владельца 08.09.2026): по умолчанию точное совпадение,
// похожее — по отдельной кнопке. Раньше похожее подмешивалось всегда, и «глаза разбегаются».
describe('режим поиска exact vs similar', () => {
  const options = [
    { id: '1', label: 'Двигатель 240-1' },
    { id: '2', label: 'Насос топливный' },
    { id: '3', label: 'Двигатель 240-11' },
  ];

  it('точный режим находит по вхождению, включая номер без дефиса', () => {
    const prepared = prepareLookupOptions(options);
    expect(rankPreparedLookupOptions(prepared, '2401', { mode: 'exact' }).map((o) => o.id)).toEqual(['1', '3']);
    expect(rankPreparedLookupOptions(prepared, 'насос', { mode: 'exact' }).map((o) => o.id)).toEqual(['2']);
  });

  it('точный режим не прощает опечатку, обычный — прощает', () => {
    const prepared = prepareLookupOptions(options);
    expect(searchPreparedLookupOptionsTiered(prepared, 'нассос', { mode: 'exact' }).similar).toEqual([]);
    expect(searchPreparedLookupOptionsTiered(prepared, 'нассос').similar.map((o) => o.id)).toEqual(['2']);
  });

  it('точный режим не исправляет раскладку, обычный — исправляет', () => {
    const prepared = prepareLookupOptions(options);
    // «yfcjc» — «насос», набранное в латинской раскладке.
    expect(rankPreparedLookupOptions(prepared, 'yfcjc', { mode: 'exact' })).toEqual([]);
    expect(rankPreparedLookupOptions(prepared, 'yfcjc').map((o) => o.id)).toEqual(['2']);
  });

  it('точный режим отсекает подпоследовательность и часть слова', () => {
    const prepared = prepareLookupOptions([{ id: '1', label: 'Двигатель 240-1' }]);
    // «дтл» — подпоследовательность «двигатель», в точном режиме это не совпадение.
    expect(rankPreparedLookupOptions(prepared, 'дтл', { mode: 'exact' })).toEqual([]);
    // Часть слова из нескольких: одно слово совпало, второе нет.
    expect(rankPreparedLookupOptions(prepared, 'двигатель насос', { mode: 'exact' })).toEqual([]);
  });

  it('точный режим находит по всем словам запроса, если нашлись все', () => {
    const prepared = prepareLookupOptions([{ id: '1', label: 'Двигатель ЯМЗ 240 турбо' }]);
    expect(rankPreparedLookupOptions(prepared, 'ямз турбо', { mode: 'exact' }).map((o) => o.id)).toEqual(['1']);
  });

  it('по умолчанию режим прежний — выпадающие списки этой правкой не меняются', () => {
    const prepared = prepareLookupOptions(options);
    expect(rankPreparedLookupOptions(prepared, 'yfcjc').map((o) => o.id)).toEqual(['2']);
    expect(rankPreparedLookupOptions(prepared, 'дтл').length).toBeGreaterThan(0);
  });
});

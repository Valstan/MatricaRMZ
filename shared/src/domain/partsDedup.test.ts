import { describe, expect, it } from 'vitest';

import {
  directoryPartIdentityKey,
  duplicateBlockReason,
  duplicateBlockReasonLabel,
  groupDirectoryPartDuplicates,
} from './partsDedup.js';

describe('directoryPartIdentityKey', () => {
  it('compact-normalizes both name and code', () => {
    expect(directoryPartIdentityKey('Вал коленчатый', '3305-01-18')).toBe(
      directoryPartIdentityKey('вал  коленчатый', '33050118'),
    );
  });
});

describe('groupDirectoryPartDuplicates', () => {
  it('groups exact (name, code) pairs as hard duplicates', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Поршень', code: '3304-06' },
      { id: 'b', name: 'поршень', code: '330406' },
      { id: 'c', name: 'Поршень', code: '9999' },
    ]);
    const exact = groups.filter((g) => g.kind === 'exact');
    expect(exact).toHaveLength(1);
    expect([...exact[0]!.ids].sort()).toEqual(['a', 'b']);
  });

  it('does NOT pair same name with two different артикулы (legal family)', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Вал коленчатый', code: '3305-01-18' },
      { id: 'b', name: 'Вал коленчатый', code: '3305-01-17' },
    ]);
    expect(groups).toHaveLength(0);
  });

  it('flags same non-empty артикул on different names as a code collision', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Картер верхний', code: '3301-15-30' },
      { id: 'b', name: 'Картер нижний', code: '3301-15-30' },
    ]);
    const collision = groups.filter((g) => g.kind === 'code-collision');
    expect(collision).toHaveLength(1);
    expect([...collision[0]!.ids].sort()).toEqual(['a', 'b']);
  });

  it('treats a shared code as a collision even for unrelated names (compact-normalized)', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Блок правый', code: '406-12-44' },
      { id: 'b', name: 'Крышка люка', code: '4061244' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('code-collision');
  });

  it('does NOT treat empty/null codes as a collision', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Форсунка', code: null },
      { id: 'b', name: 'Поршень', code: '' },
    ]);
    expect(groups).toHaveLength(0);
  });

  it('exact wins over code collision; only the odd-name third row collides', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Картер', code: '3301-15-30' },
      { id: 'b', name: 'Картер', code: '3301-15-30' },
      { id: 'c', name: 'Крышка', code: '3301-15-30' },
    ]);
    // a+b are an exact pair; c shares the code but has no non-exact peer → no collision group.
    expect(groups.filter((g) => g.kind === 'exact')).toHaveLength(1);
    expect(groups.filter((g) => g.kind === 'code-collision')).toHaveLength(0);
  });

  it('prefers code collision over fuzzy when codes are equal (no double-listing)', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Насос топливный', code: '327-00-62' },
      { id: 'b', name: 'Насос топливный НК-10М', code: '327-00-62' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('code-collision');
  });

  it('pairs typo-close names when one артикул is empty', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Маслоочиститель центробежный', code: '447-00' },
      { id: 'b', name: 'Маслоочеститель центробежный', code: null },
    ]);
    const fuzzy = groups.filter((g) => g.kind === 'fuzzy');
    expect(fuzzy).toHaveLength(1);
    expect([...fuzzy[0]!.ids].sort()).toEqual(['a', 'b']);
  });

  it('pairs word permutations', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Насос водяной', code: null },
      { id: 'b', name: 'Водяной насос', code: null },
    ]);
    expect(groups.filter((g) => g.kind === 'fuzzy')).toHaveLength(1);
  });

  it('pairs one extra word', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Генератор с муфтой привода', code: null },
      { id: 'b', name: 'Генератор с муфтой', code: null },
    ]);
    expect(groups.filter((g) => g.kind === 'fuzzy')).toHaveLength(1);
  });

  it('keeps unrelated names apart and exact members out of fuzzy clusters', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Гильза', code: '303-07-22' },
      { id: 'b', name: 'Гильза', code: '3030722' },
      { id: 'c', name: 'Форсунка', code: null },
      { id: 'd', name: 'Поршень', code: null },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('exact');
  });

  it('short names need exact match (no typo budget)', () => {
    const groups = groupDirectoryPartDuplicates([
      { id: 'a', name: 'Вал', code: null },
      { id: 'b', name: 'Вол', code: null },
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe('duplicateBlockReason', () => {
  it('blocks an identical (name, артикул) pair', () => {
    expect(
      duplicateBlockReason(
        { name: 'Вал коленчатый', code: '3305-01-18' },
        { name: 'Вал коленчатый', code: '3305-01-18' },
      ),
    ).toBe('same-name-and-article');
  });

  it('blocks the same pair written differently: case, spaces, «ё», punctuation', () => {
    // Оператор вводит от руки — гейт обязан ловить пару через ту же нормализацию,
    // что и поиск (normalizeLookupCompact), иначе дубль пройдёт из-за пробела.
    expect(
      duplicateBlockReason({ name: 'Съёмник шатуна', code: '447-00' }, { name: '  СЪЕМНИК   шатуна ', code: '447 00' }),
    ).toBe('same-name-and-article');
    expect(
      duplicateBlockReason({ name: 'Втулка (верхняя)', code: '3301-15-30' }, { name: 'Втулка верхняя', code: '33011530' }),
    ).toBe('same-name-and-article');
  });

  it('blocks a shared non-empty артикул even when the names differ', () => {
    expect(
      duplicateBlockReason({ name: 'Картер верхний', code: '3301-15-30' }, { name: 'Крышка люка', code: '3301 15 30' }),
    ).toBe('same-article');
  });

  it('allows the same name with two DIFFERENT non-empty артикулы (legal family)', () => {
    // Довод из шапки правила: «Вал коленчатый 3305-01-18» и «…-17» — законная семья,
    // запрет по одному имени остановил бы нормальную работу склада.
    expect(
      duplicateBlockReason(
        { name: 'Вал коленчатый', code: '3305-01-18' },
        { name: 'Вал коленчатый', code: '3305-01-17' },
      ),
    ).toBeNull();
  });

  it('allows the same name when one side has no артикул yet', () => {
    // Артикул ещё не заполнен — судит оператор, а не гейт.
    expect(duplicateBlockReason({ name: 'Форсунка', code: '303-07-22' }, { name: 'Форсунка', code: null })).toBeNull();
    expect(duplicateBlockReason({ name: 'Форсунка', code: '' }, { name: 'Форсунка', code: '303-07-22' })).toBeNull();
  });

  it('allows two empty records (two blank drafts are not a duplicate)', () => {
    expect(duplicateBlockReason({ name: '', code: '' }, { name: '', code: null })).toBeNull();
  });

  it('blocks the same name when BOTH артикулы are empty', () => {
    expect(duplicateBlockReason({ name: 'Поршень', code: null }, { name: 'поршень', code: '' })).toBe(
      'same-name-and-article',
    );
  });
});

describe('duplicateBlockReasonLabel', () => {
  it('gives a distinct operator text per reason', () => {
    const byPair = duplicateBlockReasonLabel('same-name-and-article');
    const byCode = duplicateBlockReasonLabel('same-article');
    expect(byPair).not.toBe(byCode);
    expect(byPair.trim()).not.toBe('');
    expect(byCode.trim()).not.toBe('');
  });
});

import { describe, expect, it } from 'vitest';

import { findUniqueExactReference, hasUnresolvedEntityReference } from './EntityReferenceField.js';

describe('findUniqueExactReference', () => {
  const options = [
    { id: 'one', label: 'Коленчатый вал' },
    { id: 'two', label: 'Шатун' },
  ];

  it('resolves one normalized exact match', () => {
    expect(findUniqueExactReference('  КОЛЕНЧАТЫЙ   ВАЛ ', options)?.id).toBe('one');
  });

  it('does not guess when exact labels are duplicated', () => {
    expect(findUniqueExactReference('шатун', [...options, { id: 'three', label: 'ШАТУН' }])).toBeNull();
  });

  it('does not accept a merely similar label', () => {
    expect(findUniqueExactReference('вал', options)).toBeNull();
  });
});

describe('hasUnresolvedEntityReference', () => {
  const selected = { id: 'part-1', label: 'Коленчатый вал' };

  it('blocks actions while typed text has no committed id', () => {
    expect(hasUnresolvedEntityReference('Новая деталь', null, null)).toBe(true);
  });

  it('allows actions for the selected label and for an empty field', () => {
    expect(hasUnresolvedEntityReference('  КОЛЕНЧАТЫЙ   ВАЛ ', selected.id, selected)).toBe(false);
    expect(hasUnresolvedEntityReference('', null, null)).toBe(false);
  });
});

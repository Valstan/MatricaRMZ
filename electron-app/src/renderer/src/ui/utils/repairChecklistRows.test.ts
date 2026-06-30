import { describe, expect, it } from 'vitest';

import {
  type ChecklistTableRow,
  BRAND_ROW_PART_ID_KEY,
  BRAND_ROW_SOURCE_KEY,
  BRAND_ROW_SOURCE_VALUE,
  ROW_PART_ID_KEY,
  ROW_PHOTOS_KEY,
  ROW_SELECTED_KEY,
  clearBrandRowMeta,
  defectRowSignature,
  getRowPartId,
  getRowPhotos,
  getRowSelected,
  isBrandLinkedChecklistRow,
  isInventoryRowVisibleForVariant,
  markBrandLinkedRow,
  mergeBrandManagedRows,
  preserveRowIdentityMeta,
  rowPartIdFromOptionId,
  withRowPhotos,
  withRowSelected,
} from './repairChecklistRows.js';

const fileRef = (id: string) => ({ id, name: `${id}.jpg`, size: 1, mime: 'image/jpeg', sha256: id, createdAt: 0 });

// defect-shaped editable-field merge: keep the operator's scrap_qty across resync.
const mergeDefectEditable = (base: ChecklistTableRow, prev: ChecklistTableRow | null): ChecklistTableRow => ({
  ...base,
  scrap_qty: Number((prev as any)?.scrap_qty ?? 0),
});

function brandRow(partId: string, name: string, partNumber: string, extra: Partial<ChecklistTableRow> = {}): ChecklistTableRow {
  return markBrandLinkedRow({ part_name: name, part_number: partNumber, quantity: 1, repairable_qty: 1, scrap_qty: 0, ...extra }, partId);
}

describe('rowPartIdFromOptionId', () => {
  it('strips the part: prefix to match unprefixed brand ids', () => {
    expect(rowPartIdFromOptionId('part:42')).toBe('42');
  });
  it('keeps node ids namespaced so they cannot collide with part ids', () => {
    expect(rowPartIdFromOptionId('node:42')).toBe('node:42');
  });
  it('returns empty for empty/null selection', () => {
    expect(rowPartIdFromOptionId('')).toBe('');
    expect(rowPartIdFromOptionId(null)).toBe('');
    expect(rowPartIdFromOptionId(undefined)).toBe('');
  });
});

describe('getRowPartId', () => {
  it('prefers the brand part id', () => {
    expect(getRowPartId({ [BRAND_ROW_PART_ID_KEY]: '7', [ROW_PART_ID_KEY]: '9' } as any)).toBe('7');
  });
  it('falls back to the manual part id', () => {
    expect(getRowPartId({ [ROW_PART_ID_KEY]: '9' } as any)).toBe('9');
  });
  it('is empty for a legacy row without ids', () => {
    expect(getRowPartId({ part_name: 'Гильза' } as any)).toBe('');
  });
});

describe('isInventoryRowVisibleForVariant', () => {
  const membership = new Map<string, Set<string>>([
    ['p-a', new Set(['A'])],
    ['p-b', new Set(['B'])],
    ['p-ab', new Set(['A', 'B'])],
  ]);

  it('shows everything when no active variant', () => {
    expect(isInventoryRowVisibleForVariant('p-a', membership, null)).toBe(true);
    expect(isInventoryRowVisibleForVariant('p-b', membership, '')).toBe(true);
  });
  it('shows a shared part (no BOM membership) regardless of variant', () => {
    expect(isInventoryRowVisibleForVariant('p-shared', membership, 'A')).toBe(true);
    expect(isInventoryRowVisibleForVariant('', membership, 'A')).toBe(true);
  });
  it('shows a part of the matching variant', () => {
    expect(isInventoryRowVisibleForVariant('p-a', membership, 'A')).toBe(true);
  });
  it('hides a part that belongs only to another variant', () => {
    expect(isInventoryRowVisibleForVariant('p-b', membership, 'A')).toBe(false);
  });
  it('shows a part that belongs to several variants including the active one', () => {
    expect(isInventoryRowVisibleForVariant('p-ab', membership, 'A')).toBe(true);
    expect(isInventoryRowVisibleForVariant('p-ab', membership, 'B')).toBe(true);
  });
  it('trims the active variant before comparing', () => {
    expect(isInventoryRowVisibleForVariant('p-a', membership, '  A  ')).toBe(true);
    expect(isInventoryRowVisibleForVariant('p-b', membership, '  A  ')).toBe(false);
  });
});

describe('preserveRowIdentityMeta', () => {
  it('re-attaches brand markers', () => {
    const meta = preserveRowIdentityMeta(brandRow('5', 'Гильза', '303-07'));
    expect(meta[BRAND_ROW_SOURCE_KEY]).toBe(BRAND_ROW_SOURCE_VALUE);
    expect(meta[BRAND_ROW_PART_ID_KEY]).toBe('5');
  });
  it('re-attaches a manual part id', () => {
    const meta = preserveRowIdentityMeta({ part_name: 'Болт', [ROW_PART_ID_KEY]: '99' } as any);
    expect(meta[ROW_PART_ID_KEY]).toBe('99');
    expect(meta[BRAND_ROW_SOURCE_KEY]).toBeUndefined();
  });
  it('returns nothing for a plain legacy row', () => {
    expect(preserveRowIdentityMeta({ part_name: 'Болт' } as any)).toEqual({});
  });
  it('survives null/undefined prev', () => {
    expect(preserveRowIdentityMeta(null)).toEqual({});
    expect(preserveRowIdentityMeta(undefined)).toEqual({});
  });
  it('carries the __photos meta through normalization (MVP-2)', () => {
    const json = JSON.stringify([fileRef('a')]);
    const meta = preserveRowIdentityMeta({ part_name: 'Болт', [ROW_PART_ID_KEY]: '99', [ROW_PHOTOS_KEY]: json } as any);
    expect(meta[ROW_PHOTOS_KEY]).toBe(json);
    expect(meta[ROW_PART_ID_KEY]).toBe('99');
  });
  it('carries the __selected meta through normalization (acts Ф1)', () => {
    expect(preserveRowIdentityMeta({ part_name: 'Болт', [ROW_SELECTED_KEY]: true } as any)[ROW_SELECTED_KEY]).toBe('1');
    expect(preserveRowIdentityMeta({ part_name: 'Болт', [ROW_SELECTED_KEY]: '1' } as any)[ROW_SELECTED_KEY]).toBe('1');
  });
  it('does not emit __selected for an unselected row', () => {
    expect(preserveRowIdentityMeta({ part_name: 'Болт' } as any)[ROW_SELECTED_KEY]).toBeUndefined();
    expect(preserveRowIdentityMeta({ part_name: 'Болт', [ROW_SELECTED_KEY]: false } as any)[ROW_SELECTED_KEY]).toBeUndefined();
  });
});

describe('getRowSelected / withRowSelected (acts Ф1)', () => {
  it('reads boolean, "1" and 1 as selected', () => {
    expect(getRowSelected({ [ROW_SELECTED_KEY]: true } as any)).toBe(true);
    expect(getRowSelected({ [ROW_SELECTED_KEY]: '1' } as any)).toBe(true);
    expect(getRowSelected({ [ROW_SELECTED_KEY]: 1 } as any)).toBe(true);
  });
  it('treats a missing or falsy flag as not selected', () => {
    expect(getRowSelected({ part_name: 'Вал' })).toBe(false);
    expect(getRowSelected({ [ROW_SELECTED_KEY]: false } as any)).toBe(false);
    expect(getRowSelected({ [ROW_SELECTED_KEY]: '' } as any)).toBe(false);
  });
  it('sets the flag when selecting and drops the key when deselecting', () => {
    const on = withRowSelected({ part_name: 'Вал' }, true);
    expect(getRowSelected(on)).toBe(true);
    const off = withRowSelected(on, false);
    expect((off as any)[ROW_SELECTED_KEY]).toBeUndefined();
    expect(getRowSelected(off)).toBe(false);
  });
});

describe('getRowPhotos / withRowPhotos (MVP-2)', () => {
  it('round-trips a list of FileRefs', () => {
    const photos = [fileRef('a'), fileRef('b')];
    const row = withRowPhotos({ part_name: 'Вал' }, photos);
    expect(typeof (row as any)[ROW_PHOTOS_KEY]).toBe('string');
    expect(getRowPhotos(row).map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('drops the meta key when the list is empty', () => {
    const row = withRowPhotos({ part_name: 'Вал', [ROW_PHOTOS_KEY]: JSON.stringify([fileRef('a')]) }, []);
    expect((row as any)[ROW_PHOTOS_KEY]).toBeUndefined();
    expect(getRowPhotos(row)).toEqual([]);
  });
  it('returns empty for a row without photos or with garbage', () => {
    expect(getRowPhotos({ part_name: 'Вал' })).toEqual([]);
    expect(getRowPhotos({ [ROW_PHOTOS_KEY]: 'not json' } as any)).toEqual([]);
  });
  it('filters out non-FileRef entries', () => {
    const row = { [ROW_PHOTOS_KEY]: JSON.stringify([{ id: 'x' }, fileRef('ok')]) } as any;
    expect(getRowPhotos(row).map((p) => p.id)).toEqual(['ok']);
  });
});

describe('clearBrandRowMeta', () => {
  it('drops brand markers but keeps the manual part id (identity survives)', () => {
    const row = { part_name: 'Болт', [ROW_PART_ID_KEY]: '99', [BRAND_ROW_SOURCE_KEY]: BRAND_ROW_SOURCE_VALUE, [BRAND_ROW_PART_ID_KEY]: '99' } as any;
    const cleared = clearBrandRowMeta(row);
    expect(cleared[BRAND_ROW_SOURCE_KEY]).toBeUndefined();
    expect(cleared[BRAND_ROW_PART_ID_KEY]).toBeUndefined();
    expect((cleared as any)[ROW_PART_ID_KEY]).toBe('99');
  });
});

describe('mergeBrandManagedRows — G3 id-keying', () => {
  it('preserves brand-row operator edits across resync', () => {
    const current = [brandRow('5', 'Гильза', '303-07', { scrap_qty: 3 })];
    const fresh = [brandRow('5', 'Гильза', '303-07')];
    const merged = mergeBrandManagedRows(current, fresh, defectRowSignature, mergeDefectEditable);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.scrap_qty).toBe(3);
    expect(isBrandLinkedChecklistRow(merged[0]!)).toBe(true);
  });

  it('KEEPS a manual id-carrying row whose text collides with a brand row (G3 regression)', () => {
    // Manual row picked a DIFFERENT part (id 999) that happens to share name+number text with brand part 5.
    const manual: ChecklistTableRow = { part_name: 'Гильза', part_number: '303-07', scrap_qty: 2, [ROW_PART_ID_KEY]: '999' };
    const current = [brandRow('5', 'Гильза', '303-07'), manual];
    const fresh = [brandRow('5', 'Гильза', '303-07')];
    const merged = mergeBrandManagedRows(current, fresh, defectRowSignature, mergeDefectEditable);
    // Old text-signature logic would have dropped the manual row; id-keying keeps it.
    expect(merged).toHaveLength(2);
    const kept = merged.find((r) => getRowPartId(r) === '999');
    expect(kept).toBeDefined();
    expect(kept!.scrap_qty).toBe(2);
  });

  it('dedups by id and merges edits when a manual part becomes brand-managed', () => {
    // Operator manually tracked part 5 (scrap_qty 4); next sync the engine brand now lists part 5.
    const manual: ChecklistTableRow = { part_name: 'Гильза', part_number: '303-07', scrap_qty: 4, [ROW_PART_ID_KEY]: '5' };
    const current = [manual];
    const fresh = [brandRow('5', 'Гильза', '303-07')];
    const merged = mergeBrandManagedRows(current, fresh, defectRowSignature, mergeDefectEditable);
    expect(merged).toHaveLength(1);
    expect(isBrandLinkedChecklistRow(merged[0]!)).toBe(true);
    expect(merged[0]!.scrap_qty).toBe(4); // edit carried over by id
  });

  it('still drops a legacy id-less manual row whose text collides with a brand row (fallback)', () => {
    const legacy: ChecklistTableRow = { part_name: 'Гильза', part_number: '303-07', scrap_qty: 1 };
    const current = [brandRow('5', 'Гильза', '303-07'), legacy];
    const fresh = [brandRow('5', 'Гильза', '303-07')];
    const merged = mergeBrandManagedRows(current, fresh, defectRowSignature, mergeDefectEditable);
    expect(merged).toHaveLength(1);
    expect(getRowPartId(merged[0]!)).toBe('5');
  });

  it('keeps a genuinely distinct manual row (no id collision, no text collision)', () => {
    const manual: ChecklistTableRow = { part_name: 'Болт', part_number: 'M8', scrap_qty: 1, [ROW_PART_ID_KEY]: '77' };
    const current = [brandRow('5', 'Гильза', '303-07'), manual];
    const fresh = [brandRow('5', 'Гильза', '303-07')];
    const merged = mergeBrandManagedRows(current, fresh, defectRowSignature, mergeDefectEditable);
    expect(merged).toHaveLength(2);
    // manual row is demoted to a plain manual row (brand markers cleared) but keeps its identity
    const kept = merged.find((r) => getRowPartId(r) === '77')!;
    expect(isBrandLinkedChecklistRow(kept)).toBe(false);
    expect((kept as any)[ROW_PART_ID_KEY]).toBe('77');
  });

  it('removes a brand row no longer in the engine brand list', () => {
    const current = [brandRow('5', 'Гильза', '303-07'), brandRow('6', 'Поршень', 'P-1')];
    const fresh = [brandRow('5', 'Гильза', '303-07')];
    const merged = mergeBrandManagedRows(current, fresh, defectRowSignature, mergeDefectEditable);
    expect(merged).toHaveLength(1);
    expect(getRowPartId(merged[0]!)).toBe('5');
  });
});

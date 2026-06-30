import { describe, expect, it } from 'vitest';

import { buildSupplyRequestItemsFromInventory, collectDefectPhotosFromInventory, parseInventoryRowPhotos } from '@matricarmz/shared';

const fileRef = (id: string, name = `${id}.jpg`) => ({
  id,
  name,
  size: 1,
  mime: 'image/jpeg',
  sha256: id,
  createdAt: 0,
});

describe('buildSupplyRequestItemsFromInventory', () => {
  it('returns empty when no row is marked for replacement', () => {
    const rows = [
      { part_name: 'Гильза', quantity: 4, scrap_qty: 1, replace_qty: 0 },
      { part_name: 'Поршень', quantity: 2, repairable_qty: 2 },
    ];
    expect(buildSupplyRequestItemsFromInventory(rows)).toEqual([]);
  });

  it('extracts only replace_qty>0 rows, mapping qty and a defect-ref note', () => {
    const rows = [
      { part_name: 'Гильза', part_number: '303-07-22', assembly_unit_number: 'УЗ-1', quantity: 4, replace_qty: 2 },
      { part_name: 'Поршень', quantity: 3, repairable_qty: 3, replace_qty: 0 },
      { part_name: 'Кольцо', part_number: '50-03', quantity: 6, replace_qty: 6 },
    ];
    const items = buildSupplyRequestItemsFromInventory(rows);
    expect(items.map((i) => i.name)).toEqual(['Гильза', 'Кольцо']);
    expect(items.map((i) => i.qty)).toEqual([2, 6]);
    expect(items[0]?.lineNo).toBe(1);
    expect(items[1]?.lineNo).toBe(2);
    expect(items[0]?.note).toBe('Дефектовка: 303-07-22 · УЗ-1');
    expect(items[1]?.note).toBe('Дефектовка: 50-03');
  });

  it('carries __part_id → productId and __part_unit → unit when present', () => {
    const rows = [
      { part_name: 'Вал', quantity: 1, replace_qty: 1, __part_id: 'p-123', __part_unit: 'шт' },
    ];
    const items = buildSupplyRequestItemsFromInventory(rows);
    expect(items[0]?.productId).toBe('p-123');
    expect(items[0]?.unit).toBe('шт');
    expect(items[0]?.qty).toBe(1);
  });

  it('aggregates duplicate parts by id (sums replace_qty)', () => {
    const rows = [
      { part_name: 'Болт', quantity: 5, replace_qty: 2, __part_id: 'p-9' },
      { part_name: 'Болт', quantity: 5, replace_qty: 3, __part_id: 'p-9' },
    ];
    const items = buildSupplyRequestItemsFromInventory(rows);
    expect(items).toHaveLength(1);
    expect(items[0]?.qty).toBe(5);
    expect(items[0]?.productId).toBe('p-9');
  });

  it('aggregates by name|part_number when no id, and respects the scrap+replace<=quantity invariant', () => {
    const rows = [
      // replace_qty 9 clamped to quantity 4 by normalization
      { part_name: 'Шестерня', part_number: 'Ш-1', quantity: 4, replace_qty: 9 },
      { part_name: 'Шестерня', part_number: 'Ш-1', quantity: 2, replace_qty: 1 },
    ];
    const items = buildSupplyRequestItemsFromInventory(rows);
    expect(items).toHaveLength(1);
    expect(items[0]?.qty).toBe(5); // 4 (clamped) + 1
    expect(items[0]?.productId).toBeUndefined();
  });

  it('appends a photo count to the note when the row carries __photos', () => {
    const rows = [
      { part_name: 'Вал', part_number: 'В-1', quantity: 1, replace_qty: 1, __photos: JSON.stringify([fileRef('a'), fileRef('b')]) },
      { part_name: 'Кольцо', quantity: 1, replace_qty: 1 },
    ];
    const items = buildSupplyRequestItemsFromInventory(rows);
    expect(items[0]?.note).toBe('Дефектовка: В-1; фото: 2');
    expect(items[1]?.note).toBe('Дефектовка'); // no photos → note unchanged
  });

  it('counts distinct photo ids across aggregated rows of the same part', () => {
    const rows = [
      { part_name: 'Болт', quantity: 5, replace_qty: 2, __part_id: 'p-9', __photos: JSON.stringify([fileRef('a')]) },
      { part_name: 'Болт', quantity: 5, replace_qty: 3, __part_id: 'p-9', __photos: JSON.stringify([fileRef('a'), fileRef('c')]) },
    ];
    const items = buildSupplyRequestItemsFromInventory(rows);
    expect(items).toHaveLength(1);
    expect(items[0]?.note).toBe('Дефектовка; фото: 2'); // a (dedup) + c
  });
});

describe('collectDefectPhotosFromInventory', () => {
  it('returns empty when no replace_qty>0 row carries photos', () => {
    const rows = [
      { part_name: 'A', quantity: 1, replace_qty: 0, __photos: JSON.stringify([fileRef('x')]) },
      { part_name: 'B', quantity: 1, replace_qty: 1 },
    ];
    expect(collectDefectPhotosFromInventory(rows)).toEqual([]);
  });

  it('collects photos from replace rows only, deduped by id, first-seen order', () => {
    const rows = [
      { part_name: 'A', quantity: 2, replace_qty: 1, __photos: JSON.stringify([fileRef('x'), fileRef('y')]) },
      { part_name: 'B', quantity: 1, replace_qty: 0, __photos: JSON.stringify([fileRef('z')]) }, // skipped (no replace)
      { part_name: 'C', quantity: 1, replace_qty: 1, __photos: JSON.stringify([fileRef('y'), fileRef('w')]) },
    ];
    expect(collectDefectPhotosFromInventory(rows).map((r) => r.id)).toEqual(['x', 'y', 'w']);
  });
});

describe('parseInventoryRowPhotos', () => {
  it('parses a JSON string, an array, and tolerates garbage', () => {
    expect(parseInventoryRowPhotos(JSON.stringify([fileRef('a')])).map((r) => r.id)).toEqual(['a']);
    expect(parseInventoryRowPhotos([fileRef('b')]).map((r) => r.id)).toEqual(['b']);
    expect(parseInventoryRowPhotos('')).toEqual([]);
    expect(parseInventoryRowPhotos('not json')).toEqual([]);
    expect(parseInventoryRowPhotos(undefined)).toEqual([]);
    expect(parseInventoryRowPhotos([{ id: 'x' }, { name: 'y' }, fileRef('ok')]).map((r) => r.id)).toEqual(['ok']);
  });
});

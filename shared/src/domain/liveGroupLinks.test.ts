import { describe, expect, it } from 'vitest';

import type { PartSpecBrandLink } from './part.js';
import { recomputePartBrandLinks, livePartGroupIds } from './liveGroupLinks.js';

// Deterministic id factory for stable assertions.
function counterIds() {
  let n = 0;
  return () => `id${++n}`;
}

const gm = (obj: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(obj));

function byBrand(links: PartSpecBrandLink[]) {
  return links
    .map((l) => ({ engineBrandId: l.engineBrandId, sourceGroupId: l.sourceGroupId, quantity: l.quantity, assemblyUnitNumber: l.assemblyUnitNumber }))
    .sort((a, b) => `${a.sourceGroupId}:${a.engineBrandId}`.localeCompare(`${b.sourceGroupId}:${b.engineBrandId}`));
}

describe('recomputePartBrandLinks', () => {
  it('no membership → empty', () => {
    expect(recomputePartBrandLinks([], gm({}), {}, counterIds())).toEqual([]);
  });

  it('addGroup expands the group members into derived links (qty 1, no anchor)', () => {
    const out = recomputePartBrandLinks([], gm({ g1: ['b1', 'b2'] }), { addGroup: 'g1' }, counterIds());
    expect(byBrand(out)).toEqual([
      { engineBrandId: 'b1', sourceGroupId: 'g1', quantity: 1, assemblyUnitNumber: null },
      { engineBrandId: 'b2', sourceGroupId: 'g1', quantity: 1, assemblyUnitNumber: null },
    ]);
    expect(out.some((l) => l.engineBrandId === null)).toBe(false);
  });

  it('a manual link for a brand blocks a derived duplicate (one link, manual wins)', () => {
    const existing: PartSpecBrandLink[] = [{ id: 'm1', engineBrandId: 'b1', assemblyUnitNumber: 'U', quantity: 7 }];
    const out = recomputePartBrandLinks(existing, gm({ g1: ['b1', 'b2'] }), { addGroup: 'g1' }, counterIds());
    // b1 stays manual (id m1, qty 7), b2 becomes derived. No derived for b1.
    const b1 = out.filter((l) => l.engineBrandId === 'b1');
    expect(b1).toHaveLength(1);
    expect(b1[0]).toEqual({ id: 'm1', engineBrandId: 'b1', assemblyUnitNumber: 'U', quantity: 7 });
    expect(out.find((l) => l.engineBrandId === 'b2')?.sourceGroupId).toBe('g1');
  });

  it('brand in two groups → single derived attributed to the sorted-first group', () => {
    const out = recomputePartBrandLinks([], gm({ g2: ['b1'], g1: ['b1'] }), {}, counterIds());
    // membership only comes from existing links / opts — here neither group is followed yet:
    expect(out).toEqual([]);
    // follow both groups via existing anchors:
    const existing: PartSpecBrandLink[] = [
      { id: 'a1', engineBrandId: null, assemblyUnitNumber: null, quantity: 0, sourceGroupId: 'g1' },
      { id: 'a2', engineBrandId: null, assemblyUnitNumber: null, quantity: 0, sourceGroupId: 'g2' },
    ];
    const out2 = recomputePartBrandLinks(existing, gm({ g2: ['b1'], g1: ['b1'] }), {}, counterIds());
    const b1 = out2.filter((l) => l.engineBrandId === 'b1');
    expect(b1).toHaveLength(1);
    expect(b1[0]!.sourceGroupId).toBe('g1'); // sorted-first
  });

  it('removing one of two groups re-attributes a shared brand to the remaining group', () => {
    const existing: PartSpecBrandLink[] = [
      { id: 'd1', engineBrandId: 'b1', assemblyUnitNumber: null, quantity: 1, sourceGroupId: 'g1' },
      { id: 'a2', engineBrandId: null, assemblyUnitNumber: null, quantity: 0, sourceGroupId: 'g2' },
    ];
    const out = recomputePartBrandLinks(existing, gm({ g1: ['b1'], g2: ['b1'] }), { removeGroup: 'g1' }, counterIds());
    const b1 = out.filter((l) => l.engineBrandId === 'b1');
    expect(b1).toHaveLength(1);
    expect(b1[0]!.sourceGroupId).toBe('g2'); // moved off removed g1 onto g2
  });

  it('empty group in membership → anchor emitted (null brand), no derived', () => {
    const existing: PartSpecBrandLink[] = [{ id: 'a1', engineBrandId: null, assemblyUnitNumber: null, quantity: 0, sourceGroupId: 'g1' }];
    const out = recomputePartBrandLinks(existing, gm({ g1: [] }), {}, counterIds());
    expect(out).toEqual([{ id: 'a1', engineBrandId: null, assemblyUnitNumber: null, quantity: 0, sourceGroupId: 'g1' }]);
  });

  it('deleted group (absent from members map) → its derived+anchor dropped', () => {
    const existing: PartSpecBrandLink[] = [
      { id: 'd1', engineBrandId: 'b1', assemblyUnitNumber: null, quantity: 1, sourceGroupId: 'gGone' },
      { id: 'm1', engineBrandId: 'bManual', assemblyUnitNumber: null, quantity: 2 },
    ];
    const out = recomputePartBrandLinks(existing, gm({ g1: ['x'] }), {}, counterIds());
    // manual kept, derived of gGone gone, gGone not re-added
    expect(out).toEqual([{ id: 'm1', engineBrandId: 'bManual', assemblyUnitNumber: null, quantity: 2 }]);
  });

  it('preserves operator-edited qty/assemblyUnitNumber (and id) of derived links on re-expand', () => {
    const existing: PartSpecBrandLink[] = [
      { id: 'd1', engineBrandId: 'b1', assemblyUnitNumber: 'СБ-42', quantity: 5, sourceGroupId: 'g1' },
    ];
    const out = recomputePartBrandLinks(existing, gm({ g1: ['b1', 'b2'] }), {}, counterIds());
    const b1 = out.find((l) => l.engineBrandId === 'b1')!;
    expect(b1).toEqual({ id: 'd1', engineBrandId: 'b1', assemblyUnitNumber: 'СБ-42', quantity: 5, sourceGroupId: 'g1' });
    const b2 = out.find((l) => l.engineBrandId === 'b2')!;
    expect(b2).toMatchObject({ engineBrandId: 'b2', sourceGroupId: 'g1', quantity: 1, assemblyUnitNumber: null });
  });

  it('is idempotent (second recompute with same inputs is a no-op)', () => {
    const first = recomputePartBrandLinks([], gm({ g1: ['b1', 'b2'] }), { addGroup: 'g1' }, counterIds());
    const second = recomputePartBrandLinks(first, gm({ g1: ['b1', 'b2'] }), {}, counterIds());
    expect(second).toEqual(first);
  });

  it('symmetric removal: brand dropped from group → its derived link disappears, manual stays', () => {
    const existing: PartSpecBrandLink[] = [
      { id: 'd1', engineBrandId: 'b1', assemblyUnitNumber: null, quantity: 1, sourceGroupId: 'g1' },
      { id: 'd2', engineBrandId: 'b2', assemblyUnitNumber: null, quantity: 1, sourceGroupId: 'g1' },
      { id: 'm1', engineBrandId: 'b9', assemblyUnitNumber: null, quantity: 3 },
    ];
    // b2 removed from g1
    const out = recomputePartBrandLinks(existing, gm({ g1: ['b1'] }), {}, counterIds());
    expect(out.find((l) => l.engineBrandId === 'b2')).toBeUndefined();
    expect(out.find((l) => l.engineBrandId === 'b1')?.sourceGroupId).toBe('g1');
    expect(out.find((l) => l.engineBrandId === 'b9')).toEqual({ id: 'm1', engineBrandId: 'b9', assemblyUnitNumber: null, quantity: 3 });
  });
});

describe('livePartGroupIds', () => {
  it('returns the union of sourceGroupId across links', () => {
    const links: PartSpecBrandLink[] = [
      { id: '1', engineBrandId: 'b1', assemblyUnitNumber: null, quantity: 1, sourceGroupId: 'g1' },
      { id: '2', engineBrandId: null, assemblyUnitNumber: null, quantity: 0, sourceGroupId: 'g2' },
      { id: '3', engineBrandId: 'b3', assemblyUnitNumber: null, quantity: 1 },
    ];
    expect(livePartGroupIds(links).sort()).toEqual(['g1', 'g2']);
  });
});

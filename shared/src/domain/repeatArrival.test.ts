import { describe, expect, it } from 'vitest';

import { arrivalPlacementLabel, arrivalPlacements, findArchivedArrivalIds } from './repeatArrival.js';

describe('findArchivedArrivalIds', () => {
  it('marks older arrivals archived when group has a repeat-arrival card', () => {
    const archived = findArchivedArrivalIds([
      { id: 'old', engineNumber: '2Ж03АТ0479', arrivalDate: 100 },
      { id: 'new', engineNumber: '2ж03ат0479', isRepeatArrival: true, arrivalDate: 200 },
    ]);
    expect(archived.has('old')).toBe(true);
    expect(archived.has('new')).toBe(false);
  });

  it('ignores plain duplicate groups without repeat flag (dedupe territory)', () => {
    const archived = findArchivedArrivalIds([
      { id: 'a', engineNumber: 'X-1', arrivalDate: 100 },
      { id: 'b', engineNumber: 'X-1', arrivalDate: 200 },
    ]);
    expect(archived.size).toBe(0);
  });

  it('number-collision cards are separate physical engines — never grouped/archived', () => {
    const archived = findArchivedArrivalIds([
      { id: 'a', engineNumber: 'Y-1', arrivalDate: 100 },
      { id: 'b', engineNumber: 'Y-1', isNumberCollision: true, arrivalDate: 200 },
    ]);
    expect(archived.size).toBe(0);
  });

  it('falls back to createdAt when arrivalDate missing; three arrivals → two archived', () => {
    const archived = findArchivedArrivalIds([
      { id: 'v1', engineNumber: 'Z-9', createdAt: 1 },
      { id: 'v2', engineNumber: 'Z 9', isRepeatArrival: true, createdAt: 2 },
      { id: 'v3', engineNumber: 'z-9', isRepeatArrival: true, createdAt: 3 },
    ]);
    expect(archived.has('v1')).toBe(true);
    expect(archived.has('v2')).toBe(true);
    expect(archived.has('v3')).toBe(false);
  });

  it('empty numbers ignored', () => {
    expect(findArchivedArrivalIds([{ id: 'a' }, { id: 'b', isRepeatArrival: true }]).size).toBe(0);
  });
});

describe('arrivalPlacements', () => {
  it('three arrivals of one number: archived/archived/current, index 1..3, total 3 for each', () => {
    const map = arrivalPlacements([
      { id: 'first', engineNumber: '2Ж03АТ0479', arrivalDate: Date.UTC(2024, 5, 1) },
      { id: 'second', engineNumber: '2ж03ат0479', isRepeatArrival: true, arrivalDate: Date.UTC(2025, 5, 1) },
      { id: 'third', engineNumber: '2Ж-03 АТ 0479', isRepeatArrival: true, arrivalDate: Date.UTC(2026, 5, 1) },
    ]);
    expect(map.size).toBe(3);
    expect(map.get('first')).toMatchObject({ role: 'archived', index: 1, total: 3 });
    expect(map.get('second')).toMatchObject({ role: 'archived', index: 2, total: 3 });
    expect(map.get('third')).toMatchObject({ role: 'current', index: 3, total: 3 });
  });

  it('newest is by arrivalDate, and by createdAt only when arrivalDate is missing', () => {
    // Свежесть заезда — про приход двигателя, а не про заведение карточки: поздно
    // заведённая карточка старого заезда не должна оказаться «свежей».
    const byArrival = arrivalPlacements([
      { id: 'late-created', engineNumber: 'A-1', arrivalDate: 100, createdAt: 9000 },
      { id: 'real-newest', engineNumber: 'A-1', isRepeatArrival: true, arrivalDate: 200, createdAt: 1 },
    ]);
    expect(byArrival.get('late-created')?.role).toBe('archived');
    expect(byArrival.get('real-newest')?.role).toBe('current');

    const byCreated = arrivalPlacements([
      { id: 'no-date-old', engineNumber: 'B-1', arrivalDate: null, createdAt: 10 },
      { id: 'no-date-new', engineNumber: 'B-1', isRepeatArrival: true, createdAt: 20 },
    ]);
    expect(byCreated.get('no-date-old')?.role).toBe('archived');
    expect(byCreated.get('no-date-new')?.role).toBe('current');
  });

  it('plain duplicates without a repeat flag stay out of the map entirely', () => {
    const map = arrivalPlacements([
      { id: 'a', engineNumber: 'C-7', arrivalDate: 100 },
      { id: 'b', engineNumber: 'C-7', arrivalDate: 200 },
    ]);
    expect(map.size).toBe(0);
  });

  it('number-collision card is out of the group: no placement of its own, and total stays 2', () => {
    const map = arrivalPlacements([
      { id: 'arr-1', engineNumber: 'D-5', arrivalDate: 100 },
      { id: 'arr-2', engineNumber: 'D-5', isRepeatArrival: true, arrivalDate: 200 },
      { id: 'other-engine', engineNumber: 'D-5', isNumberCollision: true, isRepeatArrival: true, arrivalDate: 300 },
    ]);
    expect(map.has('other-engine')).toBe(false);
    expect(map.get('arr-1')).toMatchObject({ role: 'archived', index: 1, total: 2 });
    expect(map.get('arr-2')).toMatchObject({ role: 'current', index: 2, total: 2 });
  });

  it('single arrival gets no entry — role "single" is the absence of a placement', () => {
    const map = arrivalPlacements([{ id: 'only', engineNumber: 'E-3', isRepeatArrival: true, arrivalDate: 100 }]);
    expect(map.size).toBe(0);
    expect(map.get('only')).toBeUndefined();
    expect(arrivalPlacementLabel(map.get('only'))).toBe('');
  });

  it('equal dates keep one stable order — the same input in another order gives the same index', () => {
    const at = Date.UTC(2026, 0, 10);
    const a = { id: 'a', engineNumber: 'F-2', arrivalDate: at };
    const b = { id: 'b', engineNumber: 'F-2', isRepeatArrival: true, arrivalDate: at };
    const c = { id: 'c', engineNumber: 'F-2', arrivalDate: at };
    const first = arrivalPlacements([b, a, c]);
    const second = arrivalPlacements([c, b, a]);
    for (const id of ['a', 'b', 'c']) {
      expect(second.get(id)?.index).toBe(first.get(id)?.index);
      expect(second.get(id)?.role).toBe(first.get(id)?.role);
    }
    expect(first.get('a')?.index).toBe(1);
    expect(first.get('c')).toMatchObject({ role: 'current', index: 3, total: 3 });
  });

  it('year comes from arrivalDate and shows up only in the archived label', () => {
    const map = arrivalPlacements([
      { id: 'old', engineNumber: 'G-8', arrivalDate: Date.UTC(2025, 5, 15, 12) },
      { id: 'fresh', engineNumber: 'G-8', isRepeatArrival: true, arrivalDate: Date.UTC(2026, 5, 15, 12) },
    ]);
    expect(map.get('old')?.year).toBe(2025);
    expect(map.get('fresh')?.year).toBe(2026);
    expect(arrivalPlacementLabel(map.get('old'))).toBe('архивный заезд 2025 (1 из 2)');
    expect(arrivalPlacementLabel(map.get('fresh'))).toBe('свежий заезд (2 из 2)');
    expect(arrivalPlacementLabel(map.get('fresh'))).not.toContain('2026');
  });
});

describe('arrivalPlacementLabel', () => {
  it('says nothing without a placement and nothing for a single arrival', () => {
    expect(arrivalPlacementLabel(undefined)).toBe('');
    expect(arrivalPlacementLabel({ role: 'single', index: 1, total: 1 })).toBe('');
  });

  it('archived with unknown year drops the year, not the counter', () => {
    expect(arrivalPlacementLabel({ role: 'archived', index: 1, total: 3 })).toBe('архивный заезд (1 из 3)');
  });
});

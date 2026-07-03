import { describe, expect, it } from 'vitest';

import { findArchivedArrivalIds } from './repeatArrival.js';

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

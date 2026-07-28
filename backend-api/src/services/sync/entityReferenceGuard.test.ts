import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

// Table-aware in-memory db mock (same pattern as ledgerAuthzGuard.test.ts),
// extended with innerJoin (resolver queries) and update (shortage invalidation).
const state = vi.hoisted(() => ({ selectByTable: new Map<unknown, any[][]>() }));

vi.mock('../../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
    update: vi.fn(() => {
      const chain: any = {
        set: vi.fn(() => chain),
        where: vi.fn(() => Promise.resolve([])),
      };
      return chain;
    }),
  };
  return { db };
});

const { attributeDefs, attributeValues, directoryWorkshops, entities } = await import('../../database/schema.js');
const { partitionByReferenceIntegrity } = await import('./entityReferenceGuard.js');

beforeEach(() => {
  state.selectByTable.clear();
});

const WORKSHOP_ID = '0fc8a6ff-3cb0-4d58-9fd7-759f1abfe97d';
const AV_ID = '7cf347c9-af3a-40bf-bce3-63a2433029cb';

function linkAttrInput(id: string, value: string) {
  return {
    type: 'upsert' as const,
    table: SyncTableName.AttributeValues,
    row: { id, attribute_def_id: 'def-workshop', entity_id: 'ent-1', value_json: JSON.stringify(value) },
    row_id: id,
  };
}

describe('partitionByReferenceIntegrity', () => {
  it('resolves workshop links against directory_workshops (migrated out of entities)', async () => {
    state.selectByTable.set(attributeValues, [[]]); // no stored value → "changed"
    state.selectByTable.set(attributeDefs, [
      [{ id: 'def-workshop', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'workshop' }) }],
    ]);
    // resolver: entities (join) — empty; workshop lives only in directory_workshops
    state.selectByTable.set(entities, [[]]);
    state.selectByTable.set(directoryWorkshops, [[{ id: WORKSHOP_ID }]]);

    const input = linkAttrInput(AV_ID, WORKSHOP_ID);
    const { allowed, denied } = await partitionByReferenceIntegrity([input]);
    expect(denied).toHaveLength(0);
    expect(allowed).toEqual([input]);
  });

  it('denies only the offending row, not the whole batch', async () => {
    // two link checks → two stored-value lookups (both empty → changed)
    state.selectByTable.set(attributeValues, [[], []]);
    state.selectByTable.set(attributeDefs, [
      [{ id: 'def-workshop', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'workshop' }) }],
      [{ id: 'def-workshop', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'workshop' }) }],
    ]);
    state.selectByTable.set(entities, [[]]);
    state.selectByTable.set(directoryWorkshops, [[{ id: WORKSHOP_ID }]]);

    const good = linkAttrInput(AV_ID, WORKSHOP_ID);
    const bad = linkAttrInput('11111111-2222-4333-8444-555555555555', 'deadbeef-0000-4000-8000-000000000000');
    const bystander = {
      type: 'upsert' as const,
      table: SyncTableName.Entities,
      row: { id: 'ent-new', type_id: 't-engine' },
      row_id: 'ent-new',
    };
    const { allowed, denied } = await partitionByReferenceIntegrity([good, bad, bystander]);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.row_id).toBe('11111111-2222-4333-8444-555555555555');
    expect(denied[0]!.reason).toContain('not_found');
    expect(allowed).toEqual([good, bystander]);
  });

  it('passes through untouched batches', async () => {
    const bystander = {
      type: 'upsert' as const,
      table: SyncTableName.EntityTypes,
      row: { id: 't-1', code: 'engine' },
      row_id: 't-1',
    };
    const { allowed, denied } = await partitionByReferenceIntegrity([bystander]);
    expect(denied).toHaveLength(0);
    expect(allowed).toEqual([bystander]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Integration test of the work-order closing branch (PENDING §Техдолг, low-prio
// tail since 2026-05-26): closeWorkOrderAndPostDocument wired against a mocked
// db + warehouseService + enginePhaseService stack. The real shared domain
// logic (normalizeWorkOrderPayloadV3Fields, pruneEmptyWorkshopLines,
// workshopWarehouseId, produced/consumed line builders) runs unmocked, so the
// test exercises the actual close flow: load → prune → build lines → create
// doc → post → close operation → emit sync change.

vi.mock('../database/db.js', () => {
  const state = {
    operationsRows: [] as Record<string, unknown>[],
    workshopRows: [] as Record<string, unknown>[],
    nomenclatureRows: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
  };

  function rowsForTable(table: unknown): Record<string, unknown>[] {
    // Route by drizzle table identity captured lazily (schema import happens
    // after this factory runs), so compare via the table's Symbol name.
    const name = String((table as { [key: symbol]: unknown })?.[Symbol.for('drizzle:Name')] ?? '');
    if (name === 'operations') return state.operationsRows;
    if (name === 'directory_workshops') return state.workshopRows;
    if (name === 'erp_nomenclature') return state.nomenclatureRows;
    return [];
  }

  function makeSelectChain() {
    let rows: Record<string, unknown>[] = [];
    const chain = {
      from(table: unknown) {
        rows = rowsForTable(table);
        return chain;
      },
      where() {
        return chain;
      },
      limit() {
        return Promise.resolve(rows);
      },
      then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
        return Promise.resolve(rows).then(onOk, onErr);
      },
    };
    return chain;
  }

  const db = {
    select: () => makeSelectChain(),
    update: () => ({
      set(values: Record<string, unknown>) {
        state.updates.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
    insert: () => ({
      values(row: Record<string, unknown>) {
        state.inserts.push(row);
        return Promise.resolve();
      },
    }),
  };
  return { db, pool: {}, __dbTestState: state };
});

vi.mock('./warehouseService.js', () => ({
  createWarehouseDocument: vi.fn(async () => ({ ok: true as const, id: 'doc-1' })),
  planWarehouseDocument: vi.fn(async () => ({ ok: true as const })),
  postWarehouseDocument: vi.fn(async () => ({ ok: true as const })),
  cancelWarehouseDocument: vi.fn(async () => ({ ok: true as const })),
  releaseAssemblyDraftReservation: vi.fn(async () => ({ ok: true as const })),
  reserveAssemblyDraftReservation: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('./enginePhaseService.js', () => ({
  EnginePhase: { Assembled: 'assembled' },
  setEnginePhase: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('./sync/syncChangeService.js', () => ({
  recordSyncChanges: vi.fn(async () => ({ ok: true as const })),
}));

const dbModule = (await import('../database/db.js')) as unknown as {
  __dbTestState: {
    operationsRows: Record<string, unknown>[];
    workshopRows: Record<string, unknown>[];
    nomenclatureRows: Record<string, unknown>[];
    updates: Record<string, unknown>[];
    inserts: Record<string, unknown>[];
  };
};
const state = dbModule.__dbTestState;
const warehouse = await import('./warehouseService.js');
const { setEnginePhase } = await import('./enginePhaseService.js');
const { recordSyncChanges } = await import('./sync/syncChangeService.js');
const { closeWorkOrderAndPostDocument } = await import('./workOrderClosingService.js');

const actor = { id: 'actor-1', username: 'verify', role: 'superadmin' };
const OP_ID = '11111111-2222-3333-4444-555555555555';

function workshopTemplatePayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'work_order',
    workOrderNumber: 42,
    workOrderKind: 'workshop_template',
    workshopId: 'ws-1',
    freeWorks: [
      { partId: 'nom-a', partName: 'Вал', qty: 3 },
      { partId: 'nom-b', partName: 'Крышка', qty: 0 }, // template line left empty → pruned
      { partId: 'nom-a', partName: 'Вал', qty: 2 }, // same part twice → aggregated
    ],
    ...overrides,
  };
}

function operationRow(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: OP_ID,
    engineEntityId: null,
    operationType: 'work_order',
    status: 'open',
    note: null,
    performedAt: null,
    performedBy: null,
    metaJson: JSON.stringify(payload),
    createdAt: 1000,
    updatedAt: 2000,
    deletedAt: null,
    syncStatus: 'synced',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.operationsRows = [];
  state.workshopRows = [];
  state.nomenclatureRows = [];
  state.updates = [];
  state.inserts = [];
  state.workshopRows = [{ code: '5', isActive: true }];
  // both work-line partIds are valid nomenclature ids (no directory_ref bridge)
  state.nomenclatureRows = [{ id: 'nom-a', refId: null }, { id: 'nom-b', refId: null }];
});

describe('closeWorkOrderAndPostDocument — workshop_template closing branch', () => {
  it('closes the order: prunes empty template lines, aggregates, creates+posts production_release, links the doc', async () => {
    state.operationsRows = [operationRow(workshopTemplatePayload())];

    const r = await closeWorkOrderAndPostDocument({ operationId: OP_ID, actor });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.documentId).toBe('doc-1');
    expect(r.posted).toBe(true);

    // production_release goes straight to planned — no separate plan step
    expect(warehouse.createWarehouseDocument).toHaveBeenCalledTimes(1);
    expect(warehouse.planWarehouseDocument).not.toHaveBeenCalled();
    expect(warehouse.postWarehouseDocument).toHaveBeenCalledWith({ documentId: 'doc-1', actor });

    const createArgs = vi.mocked(warehouse.createWarehouseDocument).mock.calls[0]![0] as {
      docType: string;
      status: string;
      docNo: string;
      payloadJson: string;
      lines: Array<{ qty: number; nomenclatureId: string; payloadJson: string }>;
    };
    expect(createArgs.docType).toBe('production_release');
    expect(createArgs.status).toBe('planned');
    expect(createArgs.docNo).toMatch(/^WSR-WO42-/);
    // pruned qty=0 line is gone; duplicate part aggregated 3+2=5 onto the workshop warehouse
    expect(createArgs.lines).toHaveLength(1);
    expect(createArgs.lines[0]).toMatchObject({ qty: 5, nomenclatureId: 'nom-a' });
    expect(JSON.parse(createArgs.lines[0]!.payloadJson)).toMatchObject({ targetWarehouseId: 'workshop_5' });
    const header = JSON.parse(createArgs.payloadJson) as Record<string, unknown>;
    expect(header).toMatchObject({
      workshopId: 'ws-1',
      workshopWarehouseId: 'workshop_5',
      workOrderOperationId: OP_ID,
      workOrderNumber: 42,
      warehouseId: 'workshop_5',
      sourceType: 'production_release',
    });

    // operation closed, payload re-written with linkedDocumentId and pruned lines
    expect(state.updates).toHaveLength(1);
    const update = state.updates[0]!;
    expect(update.status).toBe('closed');
    expect(update.syncStatus).toBe('pending');
    const savedPayload = JSON.parse(String(update.metaJson)) as { linkedDocumentId?: string; freeWorks?: unknown[] };
    expect(savedPayload.linkedDocumentId).toBe('doc-1');
    expect(savedPayload.freeWorks).toHaveLength(2); // qty=0 line pruned from the closed payload too

    // server-side close must go through the unified sync path
    expect(recordSyncChanges).toHaveBeenCalled();
    // no engine attached, not assembly — no phase bump
    expect(setEnginePhase).not.toHaveBeenCalled();
  });

  it('refuses to close when every template line is empty (nothing to release)', async () => {
    state.operationsRows = [
      operationRow(workshopTemplatePayload({ freeWorks: [{ partId: 'nom-a', qty: 0 }, { partId: 'nom-b', qty: 0 }] })),
    ];

    const r = await closeWorkOrderAndPostDocument({ operationId: OP_ID, actor });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('все строки шаблона пустые');
    expect(warehouse.createWarehouseDocument).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it('is idempotent: already closed with a linked document returns ok without re-posting', async () => {
    state.operationsRows = [
      operationRow(workshopTemplatePayload({ linkedDocumentId: 'doc-prev' }), { status: 'closed' }),
    ];

    const r = await closeWorkOrderAndPostDocument({ operationId: OP_ID, actor });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.documentId).toBe('doc-prev');
    expect(warehouse.createWarehouseDocument).not.toHaveBeenCalled();
    expect(warehouse.postWarehouseDocument).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it('rejects a stale card (expectedUpdatedAt conflict) before any side effect', async () => {
    state.operationsRows = [operationRow(workshopTemplatePayload())];

    const r = await closeWorkOrderAndPostDocument({ operationId: OP_ID, actor, expectedUpdatedAt: 1234 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('Конфликт обновления');
    expect(warehouse.createWarehouseDocument).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it('fails when the workshop is missing or inactive', async () => {
    state.operationsRows = [operationRow(workshopTemplatePayload())];
    state.workshopRows = [{ code: '5', isActive: false }];

    const r = await closeWorkOrderAndPostDocument({ operationId: OP_ID, actor });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('цех не найден или не активен');
    expect(warehouse.createWarehouseDocument).not.toHaveBeenCalled();
  });

  it('does NOT close the operation when posting the document fails', async () => {
    state.operationsRows = [operationRow(workshopTemplatePayload())];
    vi.mocked(warehouse.postWarehouseDocument).mockResolvedValueOnce({ ok: false, error: 'нет остатка' } as never);

    const r = await closeWorkOrderAndPostDocument({ operationId: OP_ID, actor });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('Не удалось провести документ');
    // the operation must stay open — closing after a failed post would desync doc↔order
    expect(state.updates).toHaveLength(0);
    expect(recordSyncChanges).not.toHaveBeenCalled();
  });

  it('closes a Regular order without touching the warehouse at all', async () => {
    state.operationsRows = [
      operationRow({ kind: 'work_order', workOrderNumber: 7, workOrderKind: 'regular', freeWorks: [] }),
    ];

    const r = await closeWorkOrderAndPostDocument({ operationId: OP_ID, actor });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.documentId).toBeNull();
    expect(r.posted).toBe(false);
    expect(warehouse.createWarehouseDocument).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.status).toBe('closed');
    expect(recordSyncChanges).toHaveBeenCalled();
  });

  it('remaps a directory_parts id to its nomenclature via the directory_ref bridge (G1)', async () => {
    state.operationsRows = [
      operationRow(workshopTemplatePayload({ freeWorks: [{ partId: 'dp-1', partName: 'Шестерня', qty: 4 }] })),
    ];
    // dp-1 is not a nomenclature id; nom-x mirrors it via directory_ref_id
    state.nomenclatureRows = [{ id: 'nom-x', refId: 'dp-1' }];

    const r = await closeWorkOrderAndPostDocument({ operationId: OP_ID, actor });
    expect(r.ok).toBe(true);

    const createArgs = vi.mocked(warehouse.createWarehouseDocument).mock.calls[0]![0] as {
      lines: Array<{ nomenclatureId: string; payloadJson: string }>;
    };
    expect(createArgs.lines[0]!.nomenclatureId).toBe('nom-x');
    expect(JSON.parse(createArgs.lines[0]!.payloadJson)).toMatchObject({ nomenclatureId: 'nom-x' });
  });
});

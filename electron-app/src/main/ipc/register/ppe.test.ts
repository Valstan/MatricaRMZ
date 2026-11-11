import { describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: any[]) => unknown) => void handlers.set(ch, fn) },
}));

const httpCalls: Array<{ url: string; method?: string; body?: unknown }> = [];
let response: { ok: boolean; status: number; json?: unknown; text?: string } = {
  ok: true,
  status: 200,
  json: { ok: true, rows: [] },
};

vi.mock('../../services/httpClient.js', () => ({
  httpAuthed: async (_db: unknown, _base: string, url: string, opts?: { method?: string; body?: string }) => {
    httpCalls.push({ url, method: opts?.method ?? 'GET', body: opts?.body ? JSON.parse(opts.body) : undefined });
    return response;
  },
}));

import { registerPpeIpc } from './ppe.js';

function makeCtx() {
  return {
    sysDb: {},
    dataDb: () => ({}),
    mode: () => ({ mode: 'live' }) as const,
    mgr: { getApiBaseUrl: () => 'http://test' },
    logToFile: () => undefined,
    currentActor: async () => 'tester',
    currentViewer: async () => ({ login: 'tester', role: 'admin' }),
    currentPermissions: async () => ({ 'erp.dictionary.view': true, 'erp.dictionary.edit': true, 'erp.documents.post': true }),
  } as any;
}

describe('ppe IPC', () => {
  it('все 13 каналов зарегистрированы', () => {
    registerPpeIpc(makeCtx());
    for (const ch of [
      'ppe:norms:list',
      'ppe:norms:get',
      'ppe:norms:upsert',
      'ppe:normLines:wearPeriod:set',
      'ppe:cards:open',
      'ppe:cards:get',
      'ppe:cards:overview',
      'ppe:cards:byEmployee',
      'ppe:cards:assignNorms',
      'ppe:cards:close',
      'ppe:cards:issue',
      'ppe:issueEntries:markReturned',
      'ppe:issueEntries:undoReturn',
    ]) {
      expect(handlers.has(ch), ch).toBe(true);
    }
  });

  it('список норм идёт в GET /ppe/norms', async () => {
    registerPpeIpc(makeCtx());
    httpCalls.length = 0;
    response = { ok: true, status: 200, json: { ok: true, rows: [] } };
    const list = handlers.get('ppe:norms:list')!;
    const r = (await list({}, undefined)) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(httpCalls[0]).toMatchObject({ url: '/ppe/norms', method: 'GET' });
  });

  it('выдача идёт в POST /ppe/cards/:id/issue с телом', async () => {
    registerPpeIpc(makeCtx());
    httpCalls.length = 0;
    response = { ok: true, status: 200, json: { ok: true, documentId: 'd-1', entries: 2 } };
    const issue = handlers.get('ppe:cards:issue')!;
    const args = { cardId: 'c-1', warehouseId: 'w-1', lines: [{ nomenclatureId: 'n-1', qty: 2 }] };
    const r = (await issue({}, args)) as { ok: boolean; documentId?: string };
    expect(r.ok).toBe(true);
    expect(r.documentId).toBe('d-1');
    expect(httpCalls[0]).toMatchObject({ url: '/ppe/cards/c-1/issue', method: 'POST' });
    expect(httpCalls[0]?.body).toMatchObject({ warehouseId: 'w-1' });
  });

  it('без права выдачи — отказ до HTTP', async () => {
    registerPpeIpc(makeCtx());
    httpCalls.length = 0;
    const ctx = { ...makeCtx(), currentPermissions: async () => ({}) };
    registerPpeIpc(ctx);
    const issue = handlers.get('ppe:cards:issue')!;
    const r = (await issue({}, { cardId: 'c-1', warehouseId: 'w-1', lines: [] })) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(httpCalls.length).toBe(0);
  });

  it('возврат идёт в POST /ppe/issue-entries/:id/return, снятие — в .../return/undo', async () => {
    registerPpeIpc(makeCtx());
    httpCalls.length = 0;
    response = { ok: true, status: 200, json: { ok: true, entryId: 'e-1', returnedAt: 1, wearPercent: null } };
    const mark = handlers.get('ppe:issueEntries:markReturned')!;
    const r = (await mark({}, { entryId: 'e-1', wearPercent: 40 })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(httpCalls[0]).toMatchObject({ url: '/ppe/issue-entries/e-1/return', method: 'POST' });
    expect(httpCalls[0]?.body).toMatchObject({ wearPercent: 40 });

    httpCalls.length = 0;
    const undo = handlers.get('ppe:issueEntries:undoReturn')!;
    const r2 = (await undo({}, { entryId: 'e-1' })) as { ok: boolean };
    expect(r2.ok).toBe(true);
    expect(httpCalls[0]).toMatchObject({ url: '/ppe/issue-entries/e-1/return/undo', method: 'POST' });
  });

  it('без права справочников возврат не уходит на сервер', async () => {
    registerPpeIpc(makeCtx());
    httpCalls.length = 0;
    const ctx = { ...makeCtx(), currentPermissions: async () => ({}) };
    registerPpeIpc(ctx);
    const mark = handlers.get('ppe:issueEntries:markReturned')!;
    const r = (await mark({}, { entryId: 'e-1' })) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(httpCalls.length).toBe(0);
  });
});

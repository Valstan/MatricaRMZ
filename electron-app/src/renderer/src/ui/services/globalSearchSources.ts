import type { GlobalSearchKind } from '@matricarmz/shared';

// L2 of the global palette: in-memory directory lists the client already loads per page.
// Each source loads via the same IPC its page uses, so the row `id` is the navigable card id.
// Heavy server-only datasets (nomenclature, stock documents) are NOT here — they come from L3
// (server /search).

export type L2Row = Record<string, unknown>;

export type L2Source = {
  kind: GlobalSearchKind;
  load: () => Promise<L2Row[]>;
  getCode?: (row: L2Row) => string;
};

function s(v: unknown): string {
  return v == null ? '' : String(v);
}

export function pickL2Label(row: L2Row): string {
  return (
    s(row.displayName) ||
    s(row.name) ||
    s(row.fullName) ||
    s(row.engineNumber) ||
    s(row.number) ||
    s(row.docNo) ||
    s(row.title) ||
    s(row.code) ||
    s(row.id)
  ).trim();
}

function pickCode(row: L2Row): string {
  return (s(row.code) || s(row.number) || s(row.personnelNo) || s(row.login)).trim();
}

// window.matrica spans a heterogeneous API and a few of these list endpoints are typed loosely
// (e.g. tools). Cast once and guard every call — a missing/failed endpoint degrades to no hits.
const api = (): any => window.matrica as unknown as any;

async function safeList(load: () => Promise<unknown>): Promise<L2Row[]> {
  try {
    const r = await load();
    return Array.isArray(r) ? (r as L2Row[]) : [];
  } catch {
    return [];
  }
}

async function loadDirectory(code: string): Promise<L2Row[]> {
  try {
    const types = (await api().admin.entityTypes.list()) as Array<{ id: string; code: string }>;
    const t = Array.isArray(types) ? types.find((x) => s(x.code) === code) : undefined;
    if (!t?.id) return [];
    const list = await api().admin.entities.listByEntityType(t.id);
    return Array.isArray(list) ? (list as L2Row[]) : [];
  } catch {
    return [];
  }
}

export const L2_SOURCES: L2Source[] = [
  { kind: 'engine', load: () => safeList(() => api().engines.list()), getCode: pickCode },
  { kind: 'employee', load: () => safeList(() => api().employees.list()), getCode: pickCode },
  { kind: 'request', load: () => safeList(() => api().supplyRequests.list()), getCode: pickCode },
  { kind: 'work_order', load: () => safeList(() => api().workOrders.list()), getCode: pickCode },
  { kind: 'tool', load: () => safeList(() => api().tools.list()), getCode: pickCode },
  { kind: 'tool_property', load: () => safeList(() => api().tools.properties.list()), getCode: pickCode },
  { kind: 'engine_brand', load: () => loadDirectory('engine_brand'), getCode: pickCode },
  { kind: 'counterparty', load: () => loadDirectory('counterparty'), getCode: pickCode },
  { kind: 'contract', load: () => loadDirectory('contract'), getCode: pickCode },
  { kind: 'service', load: () => loadDirectory('service'), getCode: pickCode },
  { kind: 'product', load: () => loadDirectory('product'), getCode: pickCode },
];

export async function loadAllL2(): Promise<Partial<Record<GlobalSearchKind, L2Row[]>>> {
  const entries = await Promise.all(L2_SOURCES.map(async (src) => [src.kind, await src.load()] as const));
  const out: Partial<Record<GlobalSearchKind, L2Row[]>> = {};
  for (const [kind, rows] of entries) out[kind] = rows;
  return out;
}

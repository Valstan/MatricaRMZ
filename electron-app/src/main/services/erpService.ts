import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { httpAuthed } from './httpClient.js';

type ErpModule = 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees';
type ErpCardModule = 'parts' | 'tools' | 'employees';

function normalizeApiBaseUrl(raw: string): string {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

function apiBaseCandidates(baseUrl: string): string[] {
  const base = normalizeApiBaseUrl(baseUrl);
  if (!base) return [];
  const candidates = new Set<string>();
  candidates.add(base);
  if (base.endsWith('/api')) {
    candidates.add(base.replace(/\/api$/, ''));
  } else {
    candidates.add(`${base}/api`);
  }
  if (base.endsWith('/api/v1')) {
    candidates.add(base.replace(/\/api\/v1$/, ''));
  } else {
    candidates.add(`${base}/api/v1`);
  }
  return Array.from(candidates);
}

function pathCandidates(path: string): string[] {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const candidates = new Set<string>();
  candidates.add(normalized);
  if (normalized.startsWith('/api/')) {
    candidates.add(normalized.replace(/^\/api/, ''));
  } else {
    candidates.add(`/api${normalized}`);
  }
  return Array.from(candidates);
}

function formatHttpError(
  r: { status: number; json?: any; text?: string },
  path?: string,
): string {
  if (r?.status === 404) {
    if (path?.startsWith('/warehouse/')) {
      return 'HTTP 404: Warehouse API недоступно на сервере (проверьте пути /warehouse, /api/warehouse и настройки nginx/proxy).';
    }
    if (path?.startsWith('/erp/')) {
      return 'HTTP 404: ERP API недоступно на сервере (проверьте пути /erp, /api/erp и настройки nginx/proxy).';
    }
    return 'HTTP 404: API недоступно на сервере (проверьте настройки nginx/proxy).';
  }
  const jsonErr = r?.json && typeof r.json === 'object' ? (r.json.error ?? r.json.message ?? null) : null;
  const rawMsg =
    typeof jsonErr === 'string'
      ? jsonErr
      : jsonErr != null
        ? JSON.stringify(jsonErr)
        : typeof r.text === 'string' && r.text.trim()
          ? r.text.trim()
          : '';
  const msg = rawMsg
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return `HTTP ${r.status}${msg ? `: ${msg}` : ''}`;
}

async function erpAuthed(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  path: string,
  init: RequestInit,
) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const first = await httpAuthed(db, apiBaseUrl, normalizedPath, init);
  if (first.status !== 404 || !normalizedPath.startsWith('/erp/')) return first;

  const base = normalizeApiBaseUrl(apiBaseUrl);
  for (const baseCandidate of apiBaseCandidates(base)) {
    for (const pathCandidate of pathCandidates(normalizedPath)) {
      if (baseCandidate === base && pathCandidate === normalizedPath) continue;
      const fallback = await httpAuthed(db, baseCandidate, pathCandidate, init);
      if (fallback.ok || fallback.status !== 404) return fallback;
    }
  }
  return first;
}

export async function erpDictionaryList(db: BetterSQLite3Database, apiBaseUrl: string, moduleName: ErpModule) {
  const path = `/erp/dictionary/${encodeURIComponent(moduleName)}`;
  try {
    const r = await erpAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: 'bad erp dictionary response' };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function erpDictionaryUpsert(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { moduleName: ErpModule; id?: string; code: string; name: string; payloadJson?: string | null },
) {
  const path = `/erp/dictionary/${encodeURIComponent(args.moduleName)}`;
  try {
    const r = await erpAuthed(db, apiBaseUrl, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(args.id ? { id: args.id } : {}),
        code: args.code,
        name: args.name,
        ...(args.payloadJson !== undefined ? { payloadJson: args.payloadJson } : {}),
      }),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function erpCardsList(db: BetterSQLite3Database, apiBaseUrl: string, moduleName: ErpCardModule) {
  const path = `/erp/cards/${encodeURIComponent(moduleName)}`;
  try {
    const r = await erpAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: 'bad erp cards response' };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function erpCardsUpsert(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: {
    moduleName: ErpCardModule;
    id?: string;
    templateId?: string | null;
    serialNo?: string | null;
    cardNo?: string | null;
    status?: string | null;
    payloadJson?: string | null;
    fullName?: string | null;
    personnelNo?: string | null;
    roleCode?: string | null;
  },
) {
  const path = `/erp/cards/${encodeURIComponent(args.moduleName)}`;
  try {
    const r = await erpAuthed(db, apiBaseUrl, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function erpDocumentsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { status?: string; docType?: string },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.status) qp.set('status', args.status);
    if (args?.docType) qp.set('docType', args.docType);
    const path = `/erp/documents${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await erpAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: 'bad erp documents response' };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function erpDocumentsCreate(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: {
    docType: string;
    docNo: string;
    docDate?: number;
    departmentId?: string | null;
    authorId?: string | null;
    payloadJson?: string | null;
    lines: Array<{ partCardId?: string | null; qty: number; price?: number | null; payloadJson?: string | null }>;
  },
) {
  const path = '/erp/documents';
  try {
    const r = await erpAuthed(db, apiBaseUrl, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function erpDocumentsPost(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  documentId: string,
) {
  const path = `/erp/documents/${encodeURIComponent(documentId)}/post`;
  try {
    const r = await erpAuthed(db, apiBaseUrl, path, { method: 'POST' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? documentId) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

async function warehouseAuthed(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  path: string,
  init: RequestInit,
  httpOpts?: { timeoutMs?: number },
) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const first = await httpAuthed(db, apiBaseUrl, normalizedPath, init, httpOpts);
  if (first.status !== 404 || !normalizedPath.startsWith('/warehouse/')) return first;

  const base = normalizeApiBaseUrl(apiBaseUrl);
  for (const baseCandidate of apiBaseCandidates(base)) {
    for (const pathCandidate of pathCandidates(normalizedPath)) {
      if (baseCandidate === base && pathCandidate === normalizedPath) continue;
      const fallback = await httpAuthed(db, baseCandidate, pathCandidate, init, httpOpts);
      if (fallback.ok || fallback.status !== 404) return fallback;
    }
  }
  return first;
}

export async function warehouseNomenclatureList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: {
    id?: string;
    search?: string;
    itemType?: string;
    directoryKind?: string;
    groupId?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.id) qp.set('id', args.id);
    if (args?.search) qp.set('search', args.search);
    if (args?.itemType) qp.set('itemType', args.itemType);
    if (args?.directoryKind) qp.set('directoryKind', args.directoryKind);
    if (args?.groupId) qp.set('groupId', args.groupId);
    if (args?.isActive !== undefined) qp.set('isActive', args.isActive ? 'true' : 'false');
    if (args?.limit !== undefined) qp.set('limit', String(Math.trunc(args.limit)));
    if (args?.offset !== undefined) qp.set('offset', String(Math.trunc(args.offset)));
    const path = `/warehouse/nomenclature${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' }, { timeoutMs: 60_000 });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>>; hasMore?: boolean };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseLookupsGet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
) {
  const path = '/warehouse/lookups';
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; lookups: Record<string, unknown> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseNomenclatureUpsert(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: Record<string, unknown>,
) {
  const path = '/warehouse/nomenclature';
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseNomenclatureDelete(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/nomenclature/${encodeURIComponent(id)}`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'DELETE' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseNomenclatureEngineBrandsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  nomenclatureId: string,
) {
  const path = `/warehouse/nomenclature/${encodeURIComponent(nomenclatureId)}/engine-brands`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseNomenclatureEngineBrandUpsert(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: Record<string, unknown>,
) {
  const path = '/warehouse/nomenclature/engine-brands';
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseNomenclatureEngineBrandDelete(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/nomenclature/engine-brands/${encodeURIComponent(id)}`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'DELETE' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseEngineInstancesList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { nomenclatureId?: string; contractId?: string; warehouseId?: string; status?: string; search?: string; limit?: number; offset?: number },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.nomenclatureId) qp.set('nomenclatureId', args.nomenclatureId);
    if (args?.contractId) qp.set('contractId', args.contractId);
    if (args?.warehouseId) qp.set('warehouseId', args.warehouseId);
    if (args?.status) qp.set('status', args.status);
    if (args?.search) qp.set('search', args.search);
    if (args?.limit !== undefined) qp.set('limit', String(Math.trunc(args.limit)));
    if (args?.offset !== undefined) qp.set('offset', String(Math.trunc(args.offset)));
    const path = `/warehouse/engine-instances${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>>; hasMore?: boolean };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseEngineInstanceUpsert(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: Record<string, unknown>,
) {
  const path = '/warehouse/engine-instances';
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseEngineInstanceDelete(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/engine-instances/${encodeURIComponent(id)}`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'DELETE' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseStockList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { warehouseId?: string; nomenclatureId?: string; search?: string; lowStockOnly?: boolean; limit?: number; offset?: number },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.warehouseId) qp.set('warehouseId', args.warehouseId);
    if (args?.nomenclatureId) qp.set('nomenclatureId', args.nomenclatureId);
    if (args?.search) qp.set('search', args.search);
    if (args?.lowStockOnly !== undefined) qp.set('lowStockOnly', args.lowStockOnly ? 'true' : 'false');
    if (args?.limit !== undefined) qp.set('limit', String(Math.trunc(args.limit)));
    if (args?.offset !== undefined) qp.set('offset', String(Math.trunc(args.offset)));
    const path = `/warehouse/stock${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>>; hasMore?: boolean };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseDocumentsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { status?: string; docType?: string; fromDate?: number; toDate?: number; search?: string; warehouseId?: string; limit?: number; offset?: number },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.status) qp.set('status', args.status);
    if (args?.docType) qp.set('docType', args.docType);
    if (args?.fromDate !== undefined) qp.set('fromDate', String(Math.trunc(args.fromDate)));
    if (args?.toDate !== undefined) qp.set('toDate', String(Math.trunc(args.toDate)));
    if (args?.search) qp.set('search', args.search);
    if (args?.warehouseId) qp.set('warehouseId', args.warehouseId);
    if (args?.limit !== undefined) qp.set('limit', String(Math.trunc(args.limit)));
    if (args?.offset !== undefined) qp.set('offset', String(Math.trunc(args.offset)));
    const path = `/warehouse/documents${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>>; hasMore?: boolean };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseDocumentGet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/documents/${encodeURIComponent(id)}`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; document: { header: Record<string, unknown>; lines: Array<Record<string, unknown>> } };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseDocumentCreate(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: Record<string, unknown>,
) {
  const path = '/warehouse/documents';
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseDocumentPost(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/documents/${encodeURIComponent(id)}/post`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'POST' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseDocumentPlan(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/documents/${encodeURIComponent(id)}/plan`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'POST' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseDocumentCancel(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/documents/${encodeURIComponent(id)}/cancel`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'POST' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id), status: String(r.json.status ?? 'cancelled') };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseForecastIncomingGet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { from: number; to: number; warehouseId?: string },
) {
  try {
    const qp = new URLSearchParams();
    qp.set('from', String(Math.trunc(args.from)));
    qp.set('to', String(Math.trunc(args.to)));
    if (args.warehouseId) qp.set('warehouseId', String(args.warehouseId));
    const path = `/warehouse/forecast/incoming?${qp.toString()}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { engineNomenclatureId?: string; status?: string },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.engineNomenclatureId) qp.set('engineNomenclatureId', args.engineNomenclatureId);
    if (args?.status) qp.set('status', args.status);
    const path = `/warehouse/assembly-bom${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomSchemaGet(db: BetterSQLite3Database, apiBaseUrl: string) {
  const path = '/warehouse/assembly-bom/schema';
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; schema: Record<string, unknown>; updatedAt: number };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomSchemaSet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { schema: unknown; renames?: Array<{ fromTypeId: string; toTypeId: string }> },
) {
  const path = '/warehouse/assembly-bom/schema';
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: args.schema,
        ...(args.renames && args.renames.length > 0 ? { renames: args.renames } : {}),
      }),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; schema: Record<string, unknown>; updatedAt: number; renamedLineCount?: number };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomSchemaUsageGet(db: BetterSQLite3Database, apiBaseUrl: string) {
  const path = '/warehouse/assembly-bom/schema/usage';
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomGet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/assembly-bom/${encodeURIComponent(id)}`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; bom: Record<string, unknown> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomUpsert(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: Record<string, unknown>,
) {
  const path = '/warehouse/assembly-bom';
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomActivateDefault(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/assembly-bom/${encodeURIComponent(id)}/activate-default`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'POST' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomArchive(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/assembly-bom/${encodeURIComponent(id)}/archive`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'POST' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomHistory(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  engineNomenclatureId: string,
) {
  const path = `/warehouse/assembly-bom/${encodeURIComponent(engineNomenclatureId)}/history`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseAssemblyBomPrint(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  const path = `/warehouse/assembly-bom/${encodeURIComponent(id)}/print`;
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; payload: Record<string, unknown> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseForecastBomGet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { engineId: string; targetEnginesPerDay?: number; horizonDays?: number; warehouseIds?: string[] },
) {
  try {
    const qp = new URLSearchParams();
    qp.set('engineId', args.engineId);
    if (args.targetEnginesPerDay !== undefined) qp.set('targetEnginesPerDay', String(Math.trunc(args.targetEnginesPerDay)));
    if (args.horizonDays !== undefined) qp.set('horizonDays', String(Math.trunc(args.horizonDays)));
    if (args.warehouseIds && args.warehouseIds.length > 0) qp.set('warehouseIds', args.warehouseIds.join(','));
    const path = `/warehouse/forecast/bom?${qp.toString()}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>>; warnings?: string[] };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseMovementsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { nomenclatureId?: string; warehouseId?: string; documentHeaderId?: string; fromDate?: number; toDate?: number; limit?: number },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.nomenclatureId) qp.set('nomenclatureId', args.nomenclatureId);
    if (args?.warehouseId) qp.set('warehouseId', args.warehouseId);
    if (args?.documentHeaderId) qp.set('documentHeaderId', args.documentHeaderId);
    if (args?.fromDate !== undefined) qp.set('fromDate', String(Math.trunc(args.fromDate)));
    if (args?.toDate !== undefined) qp.set('toDate', String(Math.trunc(args.toDate)));
    if (args?.limit !== undefined) qp.set('limit', String(Math.trunc(args.limit)));
    const path = `/warehouse/movements${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r, path) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

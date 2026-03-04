import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { httpAuthed } from './httpClient.js';

type ErpModule = 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees';
type ErpCardModule = 'parts' | 'tools' | 'employees';

function formatHttpError(r: { status: number; json?: any; text?: string }): string {
  if (r?.status === 404) {
    return 'HTTP 404: ERP API недоступно на сервере (проверьте путь /erp и настройки nginx/proxy).';
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
  const first = await httpAuthed(db, apiBaseUrl, path, init);
  // Some installations expose backend under /api/* only.
  if (first.status === 404 && path.startsWith('/erp/')) {
    const fallback = await httpAuthed(db, apiBaseUrl, `/api${path}`, init);
    if (fallback.ok || fallback.status !== 404) return fallback;
  }
  return first;
}

export async function erpDictionaryList(db: BetterSQLite3Database, apiBaseUrl: string, moduleName: ErpModule) {
  try {
    const r = await erpAuthed(db, apiBaseUrl, `/erp/dictionary/${encodeURIComponent(moduleName)}`, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
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
  try {
    const r = await erpAuthed(db, apiBaseUrl, `/erp/dictionary/${encodeURIComponent(args.moduleName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(args.id ? { id: args.id } : {}),
        code: args.code,
        name: args.name,
        ...(args.payloadJson !== undefined ? { payloadJson: args.payloadJson } : {}),
      }),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function erpCardsList(db: BetterSQLite3Database, apiBaseUrl: string, moduleName: ErpCardModule) {
  try {
    const r = await erpAuthed(db, apiBaseUrl, `/erp/cards/${encodeURIComponent(moduleName)}`, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
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
  try {
    const r = await erpAuthed(db, apiBaseUrl, `/erp/cards/${encodeURIComponent(args.moduleName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
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
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
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
  try {
    const r = await erpAuthed(db, apiBaseUrl, '/erp/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
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
  try {
    const r = await erpAuthed(db, apiBaseUrl, `/erp/documents/${encodeURIComponent(documentId)}/post`, { method: 'POST' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
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
) {
  const first = await httpAuthed(db, apiBaseUrl, path, init);
  if (first.status === 404 && path.startsWith('/warehouse/')) {
    const fallback = await httpAuthed(db, apiBaseUrl, `/api${path}`, init);
    if (fallback.ok || fallback.status !== 404) return fallback;
  }
  return first;
}

export async function warehouseNomenclatureList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { search?: string; itemType?: string; groupId?: string; isActive?: boolean },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.search) qp.set('search', args.search);
    if (args?.itemType) qp.set('itemType', args.itemType);
    if (args?.groupId) qp.set('groupId', args.groupId);
    if (args?.isActive !== undefined) qp.set('isActive', args.isActive ? 'true' : 'false');
    const path = `/warehouse/nomenclature${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseNomenclatureUpsert(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: Record<string, unknown>,
) {
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, '/warehouse/nomenclature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
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
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, `/warehouse/nomenclature/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseStockList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { warehouseId?: string; nomenclatureId?: string; search?: string; lowStockOnly?: boolean },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.warehouseId) qp.set('warehouseId', args.warehouseId);
    if (args?.nomenclatureId) qp.set('nomenclatureId', args.nomenclatureId);
    if (args?.search) qp.set('search', args.search);
    if (args?.lowStockOnly !== undefined) qp.set('lowStockOnly', args.lowStockOnly ? 'true' : 'false');
    const path = `/warehouse/stock${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseDocumentsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { status?: string; docType?: string; fromDate?: number; toDate?: number },
) {
  try {
    const qp = new URLSearchParams();
    if (args?.status) qp.set('status', args.status);
    if (args?.docType) qp.set('docType', args.docType);
    if (args?.fromDate !== undefined) qp.set('fromDate', String(Math.trunc(args.fromDate)));
    if (args?.toDate !== undefined) qp.set('toDate', String(Math.trunc(args.toDate)));
    const path = `/warehouse/documents${qp.toString() ? `?${qp.toString()}` : ''}`;
    const r = await warehouseAuthed(db, apiBaseUrl, path, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseDocumentGet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
) {
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, `/warehouse/documents/${encodeURIComponent(id)}`, { method: 'GET' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; header: Record<string, unknown>; lines: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function warehouseDocumentCreate(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: Record<string, unknown>,
) {
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, '/warehouse/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
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
  try {
    const r = await warehouseAuthed(db, apiBaseUrl, `/warehouse/documents/${encodeURIComponent(id)}/post`, { method: 'POST' });
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return { ok: true as const, id: String(r.json.id ?? id) };
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
    if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
    if (!r.json?.ok) return { ok: false as const, error: String(r.json?.error ?? 'unknown') };
    return r.json as { ok: true; rows: Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

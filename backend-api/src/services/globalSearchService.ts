import type { GlobalSearchHit, GlobalSearchResponse } from '@matricarmz/shared';

import { hasPermission, PermissionCode } from '../auth/permissions.js';
import { listWarehouseDocuments, listWarehouseNomenclature } from './warehouseService.js';

// L3 server search covers only the heavy, server-only datasets whose row id is the same id
// the renderer card opens with: nomenclature/parts (erp_nomenclature.id) and stock documents
// (erp_document_headers.id). Smaller directories (engines, brands, counterparties, employees,
// contracts, work orders, services, products, tools) are held in client memory and searched
// there (L2) with the correct entity ids — server mirror tables (erp_*) use a different id
// space, so routing their ids would open the wrong/no card.

const PER_KIND_LIMIT_DEFAULT = 12;
const TOTAL_CAP_DEFAULT = 40;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(Number.isFinite(n) ? n : lo, lo), hi);
}

export type GlobalSearchSources = {
  nomenclature?: Array<Record<string, unknown>>;
  stockDocuments?: Array<Record<string, unknown>>;
};

// Pure assembly of fetched candidate rows into unified hits. A source left undefined means the
// caller had no permission (or it failed) — that kind simply contributes nothing.
export function assembleGlobalSearch(
  query: string,
  sources: GlobalSearchSources,
  opts?: { perKindLimit?: number; totalCap?: number },
): GlobalSearchResponse {
  const q = String(query ?? '').trim();
  if (!q) return { query: '', hits: [], truncated: false };

  const perKindLimit = clamp(opts?.perKindLimit ?? PER_KIND_LIMIT_DEFAULT, 1, 50);
  const totalCap = clamp(opts?.totalCap ?? TOTAL_CAP_DEFAULT, 1, 200);
  const hits: GlobalSearchHit[] = [];

  if (sources.nomenclature) {
    for (const row of sources.nomenclature.slice(0, perKindLimit)) {
      const id = String(row.id ?? '').trim();
      if (!id) continue;
      const code = String(row.code ?? '').trim();
      const label = String(row.name ?? '').trim() || code || id;
      hits.push({ kind: 'nomenclature', id, label, ...(code ? { code } : {}) });
    }
  }

  if (sources.stockDocuments) {
    for (const row of sources.stockDocuments.slice(0, perKindLimit)) {
      const id = String(row.id ?? '').trim();
      if (!id) continue;
      const docNo = String(row.docNo ?? '').trim();
      const label = docNo || id;
      hits.push({ kind: 'stock_document', id, label, ...(docNo ? { code: docNo } : {}) });
    }
  }

  let truncated = false;
  if (hits.length > totalCap) {
    truncated = true;
    hits.length = totalCap;
  }

  return { query: q, hits, truncated };
}

export async function globalSearch(
  userId: string,
  query: string,
  opts?: { perKindLimit?: number; totalCap?: number },
): Promise<GlobalSearchResponse> {
  const q = String(query ?? '').trim();
  if (!q) return { query: '', hits: [], truncated: false };

  const perKindLimit = clamp(opts?.perKindLimit ?? PER_KIND_LIMIT_DEFAULT, 1, 50);
  const [canParts, canDocs] = await Promise.all([
    hasPermission(userId, PermissionCode.PartsView),
    hasPermission(userId, PermissionCode.ErpDocumentsView),
  ]);

  const sources: GlobalSearchSources = {};
  if (canParts) {
    const res = await listWarehouseNomenclature({ search: q, limit: perKindLimit });
    if (res.ok) sources.nomenclature = res.rows;
  }
  if (canDocs) {
    const res = await listWarehouseDocuments({ search: q, limit: perKindLimit });
    if (res.ok) sources.stockDocuments = res.rows;
  }

  return assembleGlobalSearch(q, sources, opts);
}

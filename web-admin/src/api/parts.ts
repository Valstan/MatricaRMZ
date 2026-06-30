import { apiJson } from './client.js';

// Phase 3 web-admin migration: parts are read/written through the unified directory
// (directory_parts) via /warehouse endpoints — the legacy /parts/* HTTP surface is
// deprecated (Stage H 410s it). These wrappers keep the historical return shape
// ({ ok, parts: [...] } / { ok, part: { id } }) so call-sites stay unchanged:
//   - listParts  -> GET  /warehouse/part-specs       (normalized rows -> parts)
//   - createPart -> POST /warehouse/directory-parts  (reuses the duplicate row)

type DirectoryPartRow = {
  id: string;
  name: string;
  code?: string | null;
  brandLinks?: Array<{ id: string; engineBrandId: string | null; assemblyUnitNumber: string | null; quantity: number }>;
  metadata?: { contractId?: string; statusFlags?: Record<string, boolean> } | null;
};

export type LegacyPartShape = {
  id: string;
  name: string;
  article: string | null;
  brandLinks: Array<{ id: string; engineBrandId: string | null; assemblyUnitNumber: string | null; quantity: number }>;
  contractId: string | null;
  statusFlags: Record<string, boolean> | null;
};

function toLegacyPart(row: DirectoryPartRow): LegacyPartShape {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    article: row.code ?? null,
    brandLinks: Array.isArray(row.brandLinks) ? row.brandLinks : [],
    contractId: row.metadata?.contractId ?? null,
    statusFlags: row.metadata?.statusFlags ?? null,
  };
}

// Return `any` to preserve the legacy call-site ergonomics (the previous apiJson-backed
// wrappers were untyped); call-sites read `.parts` / `.part.id` directly.
export async function listParts(args?: { q?: string; limit?: number; offset?: number; engineBrandId?: string; templateId?: string }): Promise<any> {
  // /warehouse/part-specs supports engineBrandId + templateId filters only; q/limit/offset
  // are accepted by the legacy signature but the directory list returns the full set.
  const params = new URLSearchParams();
  if (args?.engineBrandId) params.set('engineBrandId', args.engineBrandId);
  if (args?.templateId) params.set('templateId', args.templateId);
  const suffix = params.toString();
  const res = await apiJson(`/warehouse/part-specs${suffix ? `?${suffix}` : ''}`, { method: 'GET' });
  if (res?.ok && Array.isArray(res.rows)) {
    return { ok: true, parts: (res.rows as DirectoryPartRow[]).map(toLegacyPart) };
  }
  return res;
}

export async function createPart(args: { attributes?: { name?: string; code?: string } }): Promise<any> {
  const name = String(args?.attributes?.name ?? '').trim();
  const code = args?.attributes?.code ? String(args.attributes.code).trim() : '';
  const res = await apiJson('/warehouse/directory-parts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...(code ? { code } : {}) }),
  });
  // Reuse an existing directory row on the `duplicate part exists: <uuid>` contract
  // (matches the electron Stage F/G create path), so re-adding a known part succeeds.
  if (res && res.ok === false) {
    const m = String(res.error ?? '').match(/duplicate part exists:\s*([0-9a-f-]{36})/i);
    if (m) return { ok: true, part: { id: m[1] } };
  }
  return res;
}

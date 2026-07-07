import { recomputePartBrandLinks, type PartSpec, type PartSpecBrandLink } from '@matricarmz/shared';

import { parseIdArray } from './groupBrandIds.js';
import { invalidateListAllPartSpecsCache } from './partsPagination.js';

const EMPTY_SPEC: PartSpec = { code: null, dimensions: [], brandLinks: [] };

// Load membership of every engine-brand group: Map<groupId, brandIds[]>. Groups are an operator
// directory (few rows) so the per-group `entities.get` is acceptable, mirroring the other screens.
export async function loadAllGroupMembers(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const types = (await window.matrica.admin.entityTypes.list()) as Array<{ id: string; code: string }>;
  const gt = types.find((t) => String(t.code) === 'engine_brand_group');
  if (!gt?.id) return map;
  const list = (await window.matrica.admin.entities.listByEntityType(gt.id)) as Array<{ id: string }>;
  for (const row of list) {
    const det = await window.matrica.admin.entities.get(String(row.id), gt.id).catch(() => null);
    const attrs = (det as { attributes?: Record<string, unknown> } | null)?.attributes ?? {};
    map.set(String(row.id), parseIdArray(attrs.engine_brand_ids));
  }
  return map;
}

// Order-insensitive equality of two brand-link sets (idempotency guard — recompute may reorder).
function normalizeLinks(links: readonly PartSpecBrandLink[]): string {
  return JSON.stringify(
    links
      .map((l) => ({
        id: String(l.id),
        engineBrandId: l.engineBrandId ?? null,
        assemblyUnitNumber: l.assemblyUnitNumber ?? null,
        quantity: Number(l.quantity) || 0,
        sourceGroupId: l.sourceGroupId ?? null,
        inCompletenessAct: l.inCompletenessAct ?? false,
        inDefectAct: l.inDefectAct ?? false,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function sameLinks(a: readonly PartSpecBrandLink[], b: readonly PartSpecBrandLink[]): boolean {
  return normalizeLinks(a) === normalizeLinks(b);
}

async function readSpec(partId: string): Promise<PartSpec | null> {
  const r = await window.matrica.warehouse.nomenclaturePartSpecGet({ nomenclatureId: partId });
  if (!r?.ok) return null;
  const spec = (r.spec ?? EMPTY_SPEC) as PartSpec;
  return { ...EMPTY_SPEC, ...spec, brandLinks: Array.isArray(spec.brandLinks) ? spec.brandLinks : [] };
}

async function writeLinks(partId: string, spec: PartSpec, brandLinks: PartSpecBrandLink[]): Promise<boolean> {
  // Update only brandLinks; omit `metadata` so the backend leaves metadata_json untouched.
  const w = await window.matrica.warehouse.nomenclaturePartSpecUpdate({ nomenclatureId: partId, spec: { ...spec, brandLinks } });
  return Boolean(w?.ok);
}

// Re-expand every part that follows `groupId` (anchor or derived link with that sourceGroupId).
// Pass `groupMembersById` WITHOUT the group when it was deleted — recompute then drops its links.
export async function reexpandPartsForGroup(
  groupId: string,
  groupMembersById: Map<string, string[]>,
): Promise<{ changed: number; scanned: number }> {
  const specs = await window.matrica.warehouse.nomenclaturePartSpecsList();
  if (!specs?.ok) return { changed: 0, scanned: 0 };
  const candidates = (specs.rows ?? []).filter((r) =>
    (Array.isArray(r.brandLinks) ? r.brandLinks : []).some((l) => l.sourceGroupId === groupId),
  );
  let changed = 0;
  for (const row of candidates) {
    const spec = await readSpec(String(row.id));
    if (!spec) continue;
    const next = recomputePartBrandLinks(spec.brandLinks, groupMembersById);
    if (sameLinks(spec.brandLinks, next)) continue;
    if (await writeLinks(String(row.id), spec, next)) changed++;
  }
  if (changed > 0) invalidateListAllPartSpecsCache();
  return { changed, scanned: candidates.length };
}

// Self-heal one part from current group membership (backstop for stale drift). Writes only on diff.
// Returns the recomputed links so the caller (part card) can refresh its local state.
export async function selfHealPart(
  partId: string,
  groupMembersById: Map<string, string[]>,
): Promise<{ changed: boolean; brandLinks: PartSpecBrandLink[] | null }> {
  const spec = await readSpec(partId);
  if (!spec) return { changed: false, brandLinks: null };
  const next = recomputePartBrandLinks(spec.brandLinks, groupMembersById);
  if (sameLinks(spec.brandLinks, next)) return { changed: false, brandLinks: spec.brandLinks };
  const ok = await writeLinks(partId, spec, next);
  if (ok) invalidateListAllPartSpecsCache();
  return { changed: ok, brandLinks: ok ? next : spec.brandLinks };
}

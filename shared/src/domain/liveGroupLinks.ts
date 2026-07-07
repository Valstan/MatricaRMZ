import type { PartSpecBrandLink } from './part.js';

export type GroupMembersById = ReadonlyMap<string, readonly string[]>;

const defaultMakeId = (): string => globalThis.crypto.randomUUID();

/**
 * Recompute a part's derived/anchor brand-links from the FULL membership of its live groups.
 * Pure & idempotent — the single source of truth for live group↔part maintenance, called from
 * both group-save re-expansion and part-card self-heal.
 *
 * Link kinds (see {@link PartSpecBrandLink.sourceGroupId}):
 *  - manual — no `sourceGroupId`. Owned by the operator; passed through verbatim, never touched.
 *  - derived — `sourceGroupId` + `engineBrandId`. The brand is applicable because its group has it.
 *  - anchor — `sourceGroupId` + `engineBrandId=null`. Emitted only for a live group that yields no
 *    derived link (empty group, or all its brands already covered by manual/another group) so the
 *    part keeps "following" the group; invisible to every resolver (they skip null-brand links).
 *
 * Invariants:
 *  - ≤1 link per (part, brand); a manual link for a brand wins over a derived one (no double count).
 *  - Membership `M` = union of `sourceGroupId` across all existing links, then ± add/remove.
 *  - A group in `M` but absent from `groupMembersById` (deleted) drops out of `M` (anchor+derived go).
 *  - Existing derived/anchor links keep their `id` (and derived keep `assemblyUnitNumber`/`quantity`
 *    and act flags — operator edits preserved); only `sourceGroupId` is refreshed. This keeps the
 *    result stable across repeated calls with unchanged inputs (idempotent → no needless writes).
 *  - New derived links default to `{ assemblyUnitNumber: null, quantity: 1 }`.
 */
export function recomputePartBrandLinks(
  existingLinks: readonly PartSpecBrandLink[],
  groupMembersById: GroupMembersById,
  opts: { addGroup?: string; removeGroup?: string } = {},
  makeId: () => string = defaultMakeId,
): PartSpecBrandLink[] {
  // 1. Membership from existing links ± add/remove.
  const membership = new Set<string>();
  for (const l of existingLinks) {
    if (l.sourceGroupId) membership.add(l.sourceGroupId);
  }
  if (opts.addGroup) membership.add(opts.addGroup);
  if (opts.removeGroup) membership.delete(opts.removeGroup);
  // 2. Drop groups no longer known (deleted) — stable order for deterministic attribution.
  const liveGroups = [...membership].filter((g) => groupMembersById.has(g)).sort();

  // Manual links (no sourceGroupId) — kept verbatim; their brands block derived duplicates.
  const manual = existingLinks.filter((l) => !l.sourceGroupId);
  const manualBrands = new Set(manual.map((l) => String(l.engineBrandId ?? '').trim()).filter(Boolean));

  // Existing derived/anchor links indexed for id/qty preservation (idempotency).
  const existingDerivedByBrand = new Map<string, PartSpecBrandLink>();
  const existingAnchorByGroup = new Map<string, PartSpecBrandLink>();
  for (const l of existingLinks) {
    if (!l.sourceGroupId) continue;
    const brand = String(l.engineBrandId ?? '').trim();
    if (brand) {
      if (!existingDerivedByBrand.has(brand)) existingDerivedByBrand.set(brand, l);
    } else if (!existingAnchorByGroup.has(l.sourceGroupId)) {
      existingAnchorByGroup.set(l.sourceGroupId, l);
    }
  }

  // 3. Attribute each desired brand to one group (first live group by sorted id that contains it).
  const brandToGroup = new Map<string, string>();
  for (const g of liveGroups) {
    for (const raw of groupMembersById.get(g) ?? []) {
      const brand = String(raw ?? '').trim();
      if (!brand || manualBrands.has(brand) || brandToGroup.has(brand)) continue;
      brandToGroup.set(brand, g);
    }
  }

  // 4. Assemble: manual as-is + derived + anchors for live groups that produced no derived link.
  const out: PartSpecBrandLink[] = [...manual];
  const groupsWithDerived = new Set<string>();
  for (const [brand, g] of brandToGroup) {
    groupsWithDerived.add(g);
    const prev = existingDerivedByBrand.get(brand);
    out.push(prev ? { ...prev, engineBrandId: brand, sourceGroupId: g } : { id: makeId(), engineBrandId: brand, assemblyUnitNumber: null, quantity: 1, sourceGroupId: g });
  }
  for (const g of liveGroups) {
    if (groupsWithDerived.has(g)) continue;
    const prevAnchor = existingAnchorByGroup.get(g);
    out.push(prevAnchor ? { ...prevAnchor, engineBrandId: null, sourceGroupId: g } : { id: makeId(), engineBrandId: null, assemblyUnitNumber: null, quantity: 0, sourceGroupId: g });
  }
  return out;
}

/** Groups the part currently follows (union of sourceGroupId across derived+anchor links). */
export function livePartGroupIds(links: readonly PartSpecBrandLink[]): string[] {
  const s = new Set<string>();
  for (const l of links) {
    if (l.sourceGroupId) s.add(l.sourceGroupId);
  }
  return [...s];
}

export const PARTS_KINDS_COUNT_ATTR_CODE = 'parts_kinds_count';
export const PARTS_TOTAL_QTY_ATTR_CODE = 'parts_total_qty';

export type EngineBrandSummarySyncState = {
  typeId: string;
  canPersist: boolean;
  ensureAttempted: boolean;
  defsEnsured: boolean;
};

export type EngineBrandSummaryDeps = {
  entityTypesList: () => Promise<unknown[]>;
  upsertAttributeDef: (args: {
    entityTypeId: string;
    code: string;
    name: string;
    dataType: 'number';
    sortOrder: number;
  }) => Promise<{ ok: boolean; error?: unknown }>;
  setEntityAttr: (entityId: string, code: string, value: number) => Promise<{ ok: boolean; error?: unknown }>;
  listPartsByBrand: (args: {
    engineBrandId: string;
    limit: number;
    offset?: number;
  }) => Promise<{ ok: boolean; parts?: unknown[]; error?: unknown }>;
};

export function createEngineBrandSummarySyncState(): EngineBrandSummarySyncState {
  return {
    typeId: '',
    canPersist: true,
    ensureAttempted: false,
    defsEnsured: false,
  };
}

export function toStoredInteger(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return null;
}

export function isUnknownAttributeError(error: unknown): boolean {
  if (!error) return false;
  const text = String(error).toLowerCase();
  return text.includes('неизвестный атрибут') || text.includes('unknown attribute') || text.includes('attribute not found');
}

export function isPermissionDeniedError(error: unknown): boolean {
  const text = String(error || '').toLowerCase();
  return text.includes('permission denied') || text.includes('masterdata.edit');
}

export async function getEngineBrandTypeId(deps: EngineBrandSummaryDeps, state: EngineBrandSummarySyncState): Promise<string | null> {
  if (state.typeId) return state.typeId;
  const types = await deps.entityTypesList();
  const engineBrandType = types.find((t: unknown) => String((t as any)?.code) === 'engine_brand');
  if (!engineBrandType) return null;
  const id = String((engineBrandType as any).id || '').trim();
  if (!id) return null;
  state.typeId = id;
  return id;
}

export async function ensureSummaryAttributeDefs(deps: EngineBrandSummaryDeps, state: EngineBrandSummarySyncState): Promise<boolean> {
  if (!state.canPersist) return false;
  if (state.defsEnsured) return true;
  if (state.ensureAttempted) return false;
  state.ensureAttempted = true;

  const entityTypeId = await getEngineBrandTypeId(deps, state);
  if (!entityTypeId) return false;

  try {
    const rKinds = await deps.upsertAttributeDef({
      entityTypeId,
      code: PARTS_KINDS_COUNT_ATTR_CODE,
      name: 'Количество видов деталей',
      dataType: 'number',
      sortOrder: 9980,
    });
    if (!rKinds.ok && !isUnknownAttributeError(rKinds.error)) return false;

    const rQty = await deps.upsertAttributeDef({
      entityTypeId,
      code: PARTS_TOTAL_QTY_ATTR_CODE,
      name: 'Общее количество деталей',
      dataType: 'number',
      sortOrder: 9981,
    });
    if (!rQty.ok && !isUnknownAttributeError(rQty.error)) return false;

    state.defsEnsured = true;
    return true;
  } catch {
    return false;
  }
}

export async function persistBrandSummary(
  deps: EngineBrandSummaryDeps,
  state: EngineBrandSummarySyncState,
  engineBrandId: string,
  kinds: number | null,
  totalQty: number | null,
  allowCreateAttr = true,
): Promise<void> {
  if (!state.canPersist || kinds == null || totalQty == null) return;
  const cleanBrandId = String(engineBrandId || '').trim();
  if (!cleanBrandId) return;

  const rKinds = await deps.setEntityAttr(cleanBrandId, PARTS_KINDS_COUNT_ATTR_CODE, Math.max(0, Math.floor(kinds)));
  const rQty = await deps.setEntityAttr(cleanBrandId, PARTS_TOTAL_QTY_ATTR_CODE, Math.max(0, Math.floor(totalQty)));

  if (rKinds.ok && rQty.ok) return;

  const denied = isPermissionDeniedError(rKinds?.error) || isPermissionDeniedError(rQty?.error);
  if (denied) {
    state.canPersist = false;
    return;
  }

  const needsDefs = isUnknownAttributeError(rKinds?.error) || isUnknownAttributeError(rQty?.error);
  if (needsDefs && allowCreateAttr) {
    const defsReady = await ensureSummaryAttributeDefs(deps, state);
    if (!defsReady) {
      state.canPersist = false;
      return;
    }
    await persistBrandSummary(deps, state, cleanBrandId, kinds, totalQty, false);
  }
}

export function getBrandQtyFromPart(part: unknown, engineBrandId: string): { linked: boolean; quantity: number } {
  if (!engineBrandId) return { linked: false, quantity: 0 };
  const record = part as Record<string, unknown>;
  const brandLinks = Array.isArray(record?.brandLinks) ? (record.brandLinks as Array<Record<string, unknown>>) : [];
  let quantity = 0;
  let linked = false;

  for (const link of brandLinks) {
    if (String(link?.engineBrandId || '').trim() === engineBrandId) {
      const rawQty = Number((link as any)?.quantity);
      if (Number.isFinite(rawQty)) quantity += Math.max(0, Math.floor(rawQty));
      linked = true;
    }
  }

  if (brandLinks.length > 0) return { linked, quantity };

  const map = record?.engineBrandQtyMap;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const rawQty = Number((map as Record<string, unknown>)[engineBrandId]);
    if (Number.isFinite(rawQty)) {
      return { linked: true, quantity: Math.max(0, Math.floor(rawQty)) };
    }
  }

  return { linked: false, quantity: 0 };
}

export function computeSummaryFromBrandRows(rows: Array<{ quantity: unknown }>): { kinds: number; totalQty: number } {
  let kinds = rows.length;
  let totalQty = 0;
  for (const row of rows) {
    const qty = Number((row as { quantity: unknown }).quantity);
    if (Number.isFinite(qty)) totalQty += Math.max(0, Math.floor(qty));
  }
  return { kinds, totalQty };
}

export async function persistEngineBrandSummary(
  deps: EngineBrandSummaryDeps,
  state: EngineBrandSummarySyncState,
  engineBrandId: string,
  limit = 5000,
): Promise<void> {
  const cleanId = String(engineBrandId || '').trim();
  if (!cleanId) return;
  let kinds = 0;
  let totalQty = 0;
  let offset = 0;

  while (true) {
    const r = await deps.listPartsByBrand({ engineBrandId: cleanId, limit, offset });
    if (!r.ok) return;
    const parts = Array.isArray(r.parts) ? r.parts : [];
    for (const part of parts) {
      const partId = String((part as any)?.id || '').trim();
      if (!partId) continue;
      const { linked, quantity } = getBrandQtyFromPart(part, cleanId);
      if (!linked) continue;
      kinds += 1;
      totalQty += Number.isFinite(quantity) ? quantity : 0;
    }
    if (parts.length < limit) break;
    offset += limit;
  }

  await persistBrandSummary(deps, state, cleanId, kinds, totalQty);
}

export async function persistEngineBrandSummaries(
  deps: EngineBrandSummaryDeps,
  state: EngineBrandSummarySyncState,
  brandIds: string[],
): Promise<void> {
  const ids = [...new Set(brandIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return;
  await Promise.all(ids.map((id) => persistEngineBrandSummary(deps, state, id)));
}


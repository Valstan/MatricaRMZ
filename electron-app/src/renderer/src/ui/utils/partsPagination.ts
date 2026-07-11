import type { PartSpec, PartSpecBrandLink } from '@matricarmz/shared';

export type PaginatedPartsResult =
  | {
      ok: true;
      parts: unknown[];
    }
  | {
      ok: false;
      error: string;
    };

// --- Phase 2 (Variant A) part-spec source -----------------------------------
// Stage D swaps the option/brand-part consumers from the legacy parts.list onto
// the directory_parts-backed part-spec list. We expose the same legacy row shape
// ({ name, article, brandLinks }) so mapPartRowsToSearchOptions and the brand-part
// readers keep working unchanged. The part-template axis was removed in Phase 3.5
// (plans/parts-templates-deprecation-2026-06.md) — no more templateName resolution.
export type PartSpecRow = {
  id: string;
  name: string;
  article: string;
  brandLinks: Array<{
    id: string;
    engineBrandId: string | null;
    assemblyUnitNumber: string | null;
    quantity: number;
    sourceGroupId?: string;
    // Т4: галочки актов приходят в runtime-объекте привязки; нужны для act-scoped replace (G2).
    inCompletenessAct?: boolean;
    inDefectAct?: boolean;
  }>;
};

const PART_SPECS_CACHE_MS = 30_000;
let partSpecsCache: { expiresAt: number; promise?: Promise<PartSpecRow[]>; rows?: PartSpecRow[] } | null = null;

async function fetchPartSpecRows(): Promise<PartSpecRow[]> {
  const specs = await window.matrica.warehouse.nomenclaturePartSpecsList();
  if (!specs?.ok) throw new Error(specs?.error ?? 'unknown');
  return specs.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    article: String(r.code ?? ''),
    brandLinks: Array.isArray(r.brandLinks) ? r.brandLinks : [],
  }));
}

export async function listAllPartSpecs(args: { engineBrandId?: string } = {}): Promise<PaginatedPartsResult> {
  const now = Date.now();
  try {
    let rows: PartSpecRow[];
    if (partSpecsCache?.rows && partSpecsCache.expiresAt > now) {
      rows = partSpecsCache.rows;
    } else if (partSpecsCache?.promise && partSpecsCache.expiresAt > now) {
      rows = await partSpecsCache.promise;
    } else {
      const promise = fetchPartSpecRows();
      partSpecsCache = { promise, expiresAt: now + PART_SPECS_CACHE_MS };
      rows = await promise;
      partSpecsCache = { rows, expiresAt: now + PART_SPECS_CACHE_MS };
    }
    const brandId = typeof args.engineBrandId === 'string' ? args.engineBrandId.trim() : '';
    const parts = brandId
      ? rows.filter((row) => row.brandLinks.some((link) => String(link.engineBrandId ?? '').trim() === brandId))
      : rows;
    return { ok: true, parts };
  } catch (error) {
    partSpecsCache = null;
    return { ok: false, error: String(error ?? 'unknown') };
  }
}

export function invalidateListAllPartSpecsCache() {
  partSpecsCache = null;
}

// --- Phase 3 Stage G: part-spec brand-links (read-modify-write) --------------
// The legacy per-link CRUD (`window.matrica.parts.partBrandLinks.{list,upsert,delete}`)
// wrote EAV `part_engine_brand` and mirrored into directory_parts.brandLinksJson.
// Stage G drops the EAV path: brand-links now live only in the part-spec, which the
// backend exposes as a whole-spec upsert (no per-link endpoint). These helpers wrap
// nomenclaturePartSpecGet + nomenclaturePartSpecUpdate to give the call sites the same
// list/upsert/delete shape, while preserving the other spec fields (code/templateId/
// dimensions) and leaving metadata untouched. Upsert dedup (match by linkId, else by
// engineBrandId — one link per part+brand) mirrors the legacy backend upsertPartBrandLink.

export type PartSpecBrandLinkRow = {
  id: string;
  engineBrandId: string;
  assemblyUnitNumber: string;
  quantity: number;
};

type SpecBrandLink = PartSpecBrandLink;
type SpecShape = PartSpec;

const EMPTY_SPEC: SpecShape = { code: null, dimensions: [], brandLinks: [] };

async function readPartSpec(partId: string): Promise<{ ok: true; spec: SpecShape } | { ok: false; error: string }> {
  const r = await window.matrica.warehouse.nomenclaturePartSpecGet({ nomenclatureId: partId });
  if (!r?.ok) return { ok: false, error: r?.error ?? 'unknown' };
  const spec = (r.spec ?? EMPTY_SPEC) as SpecShape;
  return { ok: true, spec: { ...EMPTY_SPEC, ...spec, brandLinks: Array.isArray(spec.brandLinks) ? spec.brandLinks : [] } };
}

async function writePartSpec(partId: string, spec: SpecShape): Promise<{ ok: true } | { ok: false; error: string }> {
  const w = await window.matrica.warehouse.nomenclaturePartSpecUpdate({
    nomenclatureId: partId,
    spec,
  });
  if (!w?.ok) return { ok: false, error: w?.error ?? 'unknown' };
  invalidateListAllPartSpecsCache();
  return { ok: true };
}

export async function listPartSpecBrandLinks(args: {
  partId: string;
}): Promise<{ ok: true; brandLinks: PartSpecBrandLinkRow[] } | { ok: false; error: string }> {
  try {
    const r = await readPartSpec(String(args.partId));
    if (!r.ok) return r;
    return {
      ok: true,
      brandLinks: r.spec.brandLinks.map((l) => ({
        id: String(l.id ?? ''),
        engineBrandId: String(l.engineBrandId ?? ''),
        assemblyUnitNumber: String(l.assemblyUnitNumber ?? ''),
        quantity: Number(l.quantity) || 0,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertPartSpecBrandLink(args: {
  partId: string;
  engineBrandId: string;
  assemblyUnitNumber: string;
  quantity: number;
  linkId?: string;
  // Т4: галочки актов на привязке. undefined = не трогать текущее значение
  // (правка количества/узла не должна стирать флаги); false = явно снять.
  inCompletenessAct?: boolean;
  inDefectAct?: boolean;
}): Promise<{ ok: true; linkId: string } | { ok: false; error: string }> {
  try {
    const r = await readPartSpec(String(args.partId));
    if (!r.ok) return r;
    const links = [...r.spec.brandLinks];
    const engineBrandId = String(args.engineBrandId ?? '').trim();
    const assemblyUnitNumber = String(args.assemblyUnitNumber ?? '').trim();
    const quantity = Math.max(0, Math.floor(Number(args.quantity) || 0));

    let idx = -1;
    if (args.linkId) idx = links.findIndex((l) => String(l.id) === String(args.linkId));
    if (idx < 0) idx = links.findIndex((l) => String(l.engineBrandId ?? '') === engineBrandId);

    const prev = idx >= 0 ? links[idx] : null;
    const linkId = idx >= 0 ? String(links[idx]?.id || '') || crypto.randomUUID() : crypto.randomUUID();
    const next: SpecBrandLink = {
      id: linkId,
      engineBrandId: engineBrandId || null,
      assemblyUnitNumber: assemblyUnitNumber || null,
      quantity,
      ...((args.inCompletenessAct ?? prev?.inCompletenessAct) ? { inCompletenessAct: true } : {}),
      ...((args.inDefectAct ?? prev?.inDefectAct) ? { inDefectAct: true } : {}),
    };
    if (idx >= 0) links[idx] = next;
    else links.push(next);

    const w = await writePartSpec(String(args.partId), { ...r.spec, brandLinks: links });
    if (!w.ok) return w;
    return { ok: true, linkId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Батч: скопировать привязку детали (кол-во / № сборочной единицы / флаги актов) на несколько
 * марок разом — за ОДНО чтение+запись спеки детали (а не N раз). Для «распространить набор деталей
 * марки на все марки её группы». Merge по engineBrandId — идемпотентно (повторный прогон не плодит
 * дублей); чужие детали марок-целей не трогаются.
 *
 * Режимы (`mergeMode`):
 *  - `overwrite`   — привязка марки-цели устанавливается = источнику (кол-во/узел/флаги перезаписываются);
 *                    добавляется, если её не было. (Прежнее поведение кнопки.)
 *  - `add-missing` — существующая привязка марки-цели НЕ трогается; добавляется только недостающая.
 *                    Для актов (`ensureActFlag`) у существующей привязки лишь ПРОСТАВЛЯЕТСЯ галочка акта
 *                    (кол-во/узел/прочий флаг сохраняются) — это «отметить деталь в акте у всех марок».
 *
 * `ensureActFlag` (для scope «детали акта X»): гарантировать флаг акта у марки-цели даже в add-missing.
 */
export async function propagatePartSpecBrandLinkToBrands(args: {
  partId: string;
  targetBrandIds: string[];
  assemblyUnitNumber: string;
  quantity: number;
  inCompletenessAct: boolean;
  inDefectAct: boolean;
  mergeMode: 'overwrite' | 'add-missing';
  ensureActFlag?: 'completeness' | 'defect';
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await readPartSpec(String(args.partId));
    if (!r.ok) return r;
    const links = [...r.spec.brandLinks];
    const assemblyUnitNumber = String(args.assemblyUnitNumber ?? '').trim();
    const quantity = Math.max(0, Math.floor(Number(args.quantity) || 0));
    const actFlagKey = args.ensureActFlag === 'completeness' ? 'inCompletenessAct' : args.ensureActFlag === 'defect' ? 'inDefectAct' : null;
    let changed = false;
    for (const raw of args.targetBrandIds) {
      const brandId = String(raw ?? '').trim();
      if (!brandId) continue;
      const idx = links.findIndex((l) => String(l.engineBrandId ?? '') === brandId);
      if (idx >= 0 && args.mergeMode === 'add-missing') {
        // Существующую привязку не перезаписываем; для акта лишь гарантируем галочку.
        const cur = links[idx]!;
        if (actFlagKey && !cur[actFlagKey]) {
          links[idx] = { ...cur, [actFlagKey]: true };
          changed = true;
        }
        continue;
      }
      const linkId = idx >= 0 ? String(links[idx]?.id || '') || crypto.randomUUID() : crypto.randomUUID();
      const next: SpecBrandLink = {
        id: linkId,
        engineBrandId: brandId,
        assemblyUnitNumber: assemblyUnitNumber || null,
        quantity,
        ...(args.inCompletenessAct ? { inCompletenessAct: true } : {}),
        ...(args.inDefectAct ? { inDefectAct: true } : {}),
      };
      if (idx >= 0) links[idx] = next;
      else links.push(next);
      changed = true;
    }
    if (!changed) return { ok: true };
    const w = await writePartSpec(String(args.partId), { ...r.spec, brandLinks: links });
    if (!w.ok) return w;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Снять привязки указанных марок с ОДНОЙ детали (для режима «Полное замещение»: список деталей
 * марки-цели должен стать точно равным набору-источнику → у деталей вне набора привязки целей удаляются).
 * Прочие привязки детали (к другим маркам) сохраняются. `removed` — сколько привязок снято (0 → запись
 * не производилась).
 */
export async function removePartSpecBrandLinksForBrands(args: {
  partId: string;
  brandIds: string[];
}): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  try {
    const r = await readPartSpec(String(args.partId));
    if (!r.ok) return r;
    const targets = new Set(args.brandIds.map((b) => String(b ?? '').trim()).filter(Boolean));
    const before = r.spec.brandLinks.length;
    const links = r.spec.brandLinks.filter((l) => !targets.has(String(l.engineBrandId ?? '')));
    const removed = before - links.length;
    if (removed === 0) return { ok: true, removed: 0 };
    const w = await writePartSpec(String(args.partId), { ...r.spec, brandLinks: links });
    if (!w.ok) return w;
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * G2 (act-scoped replace): СНЯТЬ галочку одного акта у привязок указанных марок к ОДНОЙ детали,
 * НЕ удаляя привязку и не трогая кол-во/узел/вторую галочку. Для режима «перепривязать акт
 * целиком»: у деталей вне набора-источника снимается лишь галочка нужного акта, лишние детали
 * не удаляются из марки. `cleared` — сколько привязок реально изменено (0 → запись не делалась).
 */
export async function clearPartSpecBrandLinkActFlagForBrands(args: {
  partId: string;
  brandIds: string[];
  actFlag: 'completeness' | 'defect';
}): Promise<{ ok: true; cleared: number } | { ok: false; error: string }> {
  try {
    const r = await readPartSpec(String(args.partId));
    if (!r.ok) return r;
    const targets = new Set(args.brandIds.map((b) => String(b ?? '').trim()).filter(Boolean));
    const flagKey = args.actFlag === 'completeness' ? 'inCompletenessAct' : 'inDefectAct';
    let cleared = 0;
    const links = r.spec.brandLinks.map((l) => {
      if (!targets.has(String(l.engineBrandId ?? ''))) return l;
      if (!(l as Record<string, unknown>)[flagKey]) return l;
      const { [flagKey]: _drop, ...rest } = l as Record<string, unknown>;
      cleared += 1;
      return rest as typeof l;
    });
    if (cleared === 0) return { ok: true, cleared: 0 };
    const w = await writePartSpec(String(args.partId), { ...r.spec, brandLinks: links });
    if (!w.ok) return w;
    return { ok: true, cleared };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePartSpecBrandLink(args: {
  partId: string;
  linkId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await readPartSpec(String(args.partId));
    if (!r.ok) return r;
    const links = r.spec.brandLinks.filter((l) => String(l.id) !== String(args.linkId));
    return await writePartSpec(String(args.partId), { ...r.spec, brandLinks: links });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

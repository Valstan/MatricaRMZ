/**
 * Pure EAV → directory_parts field mapping for Phase 3 (parts EAV → directory_parts).
 *
 * Single source of truth shared by:
 *   - the Stage B/B.2 backfill scripts (`backfillDirectoryParts.ts`, `backfillDirectoryPartsMetadata.ts`)
 *   - the Stage C live dual-write mirror (`mirrorPartFieldsToDirectory` in `partsService.ts`)
 *
 * Keeping the mapping here (no DB import) prevents the backfill and the live mirror
 * from drifting apart. Input is a part's raw `attribute_values.value_json` keyed by
 * attribute code; output is the typed spec columns + the `PartMetadata` blob.
 */

import {
  STATUS_CODES,
  statusDateCode,
  type FileRef,
  type PartCustomFieldDef,
  type PartMetadata,
} from '@matricarmz/shared';

/** code → raw `attribute_values.value_json` for a single part (null = present-but-null). */
export type PartAttrMap = Record<string, string | null>;
export type PartCustomDefMap = Map<string, PartCustomFieldDef>;

// Codes owned by the spec columns / brand-links — never go into metadata.
const SPEC_CODES = new Set<string>([
  'name',
  'article',
  'part_template_id',
  'dimensions',
  'engine_brand_ids',
  'engine_brand_qty_map',
]);
// Codes that map to a typed PartMetadata field (handled explicitly below).
const TYPED_META_CODES = new Set<string>([
  'description',
  'assembly_unit_number',
  'engine_node_id',
  'purchase_date',
  'supplier_id',
  'supplier',
  'contract_id',
  'drawings',
  'tech_docs',
  'attachments',
]);
const STATUS_FLAG_CODES = new Set<string>(STATUS_CODES);
const STATUS_DATE_CODES = new Set<string>(STATUS_CODES.map((c) => statusDateCode(c)));

/** Whether a part attribute code is one of the known (spec/typed-meta/status) codes — the rest are custom. */
export function isKnownPartCode(code: string): boolean {
  return (
    SPEC_CODES.has(code) ||
    TYPED_META_CODES.has(code) ||
    STATUS_FLAG_CODES.has(code) ||
    STATUS_DATE_CODES.has(code)
  );
}

export function parseJsonText(raw: string | null | undefined): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function asText(raw: string | null | undefined): string | null {
  const v = parseJsonText(raw ?? null);
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function toMs(raw: string | null | undefined): number | null {
  const v = parseJsonText(raw ?? null);
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function toBool(raw: string | null | undefined): boolean {
  const v = parseJsonText(raw ?? null);
  return v === true || v === 'true' || v === 1 || v === '1';
}

export function toFileRefs(raw: string | null | undefined): FileRef[] | null {
  const v = parseJsonText(raw ?? null);
  return Array.isArray(v) && v.length ? (v as FileRef[]) : null;
}

/**
 * Typed spec columns derived from part EAV (`name`/`article`/`part_template_id`/`dimensions`).
 * `name` is null only when absent — callers must not null-out the NOT NULL sort key.
 * brand-links are sourced from `part_engine_brand` entities, not part attrs, so they are
 * handled separately by the caller.
 */
export function buildPartSpecColumns(a: PartAttrMap): {
  name: string | null;
  code: string | null;
  templateId: string | null;
  dimensionsJson: string | null;
} {
  const dims = parseJsonText(a['dimensions'] ?? null);
  return {
    name: asText(a['name']),
    code: asText(a['article']),
    templateId: asText(a['part_template_id']),
    dimensionsJson: Array.isArray(dims) && dims.length ? JSON.stringify(dims) : null,
  };
}

/**
 * The `directory_parts.metadata_json` blob (shape = shared `PartMetadata`) from the
 * residual part EAV fields. Spec/brand codes are excluded; every other attribute that
 * carries a value falls through to `custom` + `customDefs` (Решение B, per-part).
 */
export function buildPartMetadataBlob(a: PartAttrMap, customDefByCode: PartCustomDefMap): PartMetadata {
  const description = asText(a['description']);
  const assemblyUnitNumber = asText(a['assembly_unit_number']);
  const engineNodeId = asText(a['engine_node_id']);
  const purchaseDate = toMs(a['purchase_date']);
  const supplierId = asText(a['supplier_id']);
  const supplierLegacy = asText(a['supplier']);
  const contractId = asText(a['contract_id']);
  const drawings = toFileRefs(a['drawings']);
  const techDocs = toFileRefs(a['tech_docs']);
  const attachments = toFileRefs(a['attachments']);

  const statusFlags: Record<string, boolean> = {};
  for (const code of STATUS_CODES) {
    if (code in a && toBool(a[code])) statusFlags[code] = true;
  }
  const statusDates: Record<string, number> = {};
  for (const code of STATUS_CODES) {
    const d = toMs(a[statusDateCode(code)]);
    if (d != null) statusDates[code] = d;
  }

  const custom: Record<string, unknown> = {};
  for (const [code, raw] of Object.entries(a)) {
    if (isKnownPartCode(code)) continue;
    const val = parseJsonText(raw);
    if (val == null) continue;
    if (typeof val === 'string' && val.trim() === '') continue;
    custom[code] = val;
  }
  const customDefs = Object.keys(custom)
    .map((code) => customDefByCode.get(code))
    .filter((d): d is PartCustomFieldDef => Boolean(d));

  return {
    ...(description ? { description } : {}),
    ...(assemblyUnitNumber ? { assemblyUnitNumber } : {}),
    ...(engineNodeId ? { engineNodeId } : {}),
    ...(purchaseDate != null ? { purchaseDate } : {}),
    ...(supplierId ? { supplierId } : {}),
    ...(supplierLegacy ? { supplierLegacy } : {}),
    ...(contractId ? { contractId } : {}),
    ...(drawings ? { drawings } : {}),
    ...(techDocs ? { techDocs } : {}),
    ...(attachments ? { attachments } : {}),
    ...(Object.keys(statusFlags).length ? { statusFlags } : {}),
    ...(Object.keys(statusDates).length ? { statusDates } : {}),
    ...(Object.keys(custom).length ? { custom } : {}),
    ...(Object.keys(custom).length && customDefs.length ? { customDefs } : {}),
  };
}

/** `metadata_json` text for a built blob — null when the blob is empty (never stores "{}"). */
export function serializePartMetadataBlob(meta: PartMetadata): string | null {
  return Object.keys(meta).length ? JSON.stringify(meta) : null;
}

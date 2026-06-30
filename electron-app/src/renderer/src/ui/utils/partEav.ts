// Shared part-EAV helpers extracted from PartDetailsPage so the legacy part card
// and the nomenclature card (Phase 2 Stage E.2) read/write part attributes through
// one implementation. Pure functions only — no React/component state.

import {
  PART_DIMENSIONS_ATTR_CODE,
  STATUS_CODES,
  STATUS_LABELS,
  statusDateCode,
  type PartDimension,
} from '@matricarmz/shared';
import type { EnsureFieldInput } from './fieldOrder.js';

export type PartAttribute = {
  id: string;
  code: string;
  name: string;
  dataType: string;
  value: unknown;
  isRequired: boolean;
  sortOrder: number;
  metaJson?: unknown;
};

export type EntityTypeRow = { id: string; code: string; name: string };
export type TextLookupMeta = { targetTypeCode: string; storeAs: 'id' | 'label' };

export function toInputDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeDateInput(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeDimensionsValue(value: unknown): PartDimension[] {
  if (!Array.isArray(value)) return [];
  const result: PartDimension[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const rowValue = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (!name && !rowValue) continue;
    result.push({
      id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `dim-${index + 1}`,
      name,
      value: rowValue,
    });
  }
  return result;
}

export function normalizeCoreFieldValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return value;
}

export function getLinkTargetTypeCode(attr: PartAttribute): string | null {
  const meta = attr.metaJson;
  if (meta && typeof meta === 'object' && 'linkTargetTypeCode' in meta) {
    const code = (meta as { linkTargetTypeCode?: unknown }).linkTargetTypeCode;
    if (typeof code === 'string' && code.trim()) return code.trim();
  }
  if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta);
      const code = parsed?.linkTargetTypeCode;
      if (typeof code === 'string' && code.trim()) return code.trim();
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeLookupBaseCode(code: string): string {
  const cleaned = code.trim().toLowerCase();
  if (!cleaned) return '';
  if (cleaned.endsWith('_id')) return cleaned.slice(0, -3);
  if (cleaned.endsWith('_ref')) return cleaned.slice(0, -4);
  return cleaned;
}

export function getTextLookupConfig(attr: PartAttribute, entityTypes: EntityTypeRow[]): TextLookupMeta | null {
  if (attr.dataType !== 'text') return null;
  const baseCode = normalizeLookupBaseCode(attr.code);
  if (!baseCode) return null;
  let meta: Record<string, unknown> | null = null;
  if (attr.metaJson && typeof attr.metaJson === 'object') {
    meta = attr.metaJson as Record<string, unknown>;
  } else if (typeof attr.metaJson === 'string') {
    try {
      const parsed = JSON.parse(attr.metaJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  const aliases: Record<string, string> = {
    brand: 'engine_brand',
    enginebrand: 'engine_brand',
    ctr: 'customer',
    counterparty: 'customer',
    contractor: 'customer',
    partner: 'customer',
    pos: 'position_ref',
    position: 'position_ref',
    position_ref: 'position_ref',
  };
  const explicitTarget = typeof meta?.lookupTargetTypeCode === 'string' ? meta.lookupTargetTypeCode.trim().toLowerCase() : '';
  const targetTypeCode = aliases[explicitTarget] ?? aliases[baseCode] ?? baseCode;
  if (!targetTypeCode || !entityTypes.some((t) => t.code === targetTypeCode)) return null;
  const explicitStoreAs = typeof meta?.lookupStoreAs === 'string' ? meta.lookupStoreAs.trim().toLowerCase() : '';
  const storeAs: 'id' | 'label' = explicitStoreAs === 'label' ? 'label' : baseCode.endsWith('_id') ? 'id' : 'label';
  return { targetTypeCode, storeAs };
}

// Core part fields ensured as attribute defs on the part entity type. These are the
// dimensions/name/article fields PLUS the E.2-migrated fields
// (description/purchase_date/supplier/contract/status). Single source for both cards.
// The part-template field was removed in Phase 3.5 (plans/parts-templates-deprecation-2026-06.md).
export function buildPartCoreFieldDefs(): EnsureFieldInput[] {
  return [
    { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
    { code: 'article', name: 'Сборочный номер / артикул', dataType: 'text', sortOrder: 20 },
    { code: PART_DIMENSIONS_ATTR_CODE, name: 'Размеры', dataType: 'json', sortOrder: 25 },
    { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 30 },
    { code: 'purchase_date', name: 'Дата покупки', dataType: 'date', sortOrder: 40 },
    {
      code: 'supplier_id',
      name: 'Поставщик',
      dataType: 'link',
      sortOrder: 50,
      metaJson: JSON.stringify({ linkTargetTypeCode: 'customer' }),
    },
    { code: 'supplier', name: 'Поставщик (текст)', dataType: 'text', sortOrder: 60 },
    {
      code: 'contract_id',
      name: 'Контракт',
      dataType: 'link',
      sortOrder: 65,
      metaJson: JSON.stringify({ linkTargetTypeCode: 'contract' }),
    },
    ...STATUS_CODES.flatMap((code, i): EnsureFieldInput[] => [
      { code, name: STATUS_LABELS[code], dataType: 'boolean', sortOrder: 70 + i * 2 },
      { code: statusDateCode(code), name: `Дата ${STATUS_LABELS[code]}`, dataType: 'date', sortOrder: 71 + i * 2 },
    ]),
  ];
}

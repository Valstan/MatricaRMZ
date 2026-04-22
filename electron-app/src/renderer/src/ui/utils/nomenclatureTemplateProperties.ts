import type { WarehouseNomenclatureTemplateProperty } from '@matricarmz/shared';

function normalizeRow(raw: unknown): WarehouseNomenclatureTemplateProperty | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const propertyId = String(o.propertyId ?? '').trim();
  if (!propertyId) return null;
  const required = o.required === true;
  const sortOrderRaw = o.sortOrder;
  const sortOrder = typeof sortOrderRaw === 'number' && Number.isFinite(sortOrderRaw) ? sortOrderRaw : undefined;
  const defaultValue = 'defaultValue' in o ? o.defaultValue : undefined;
  return {
    propertyId,
    ...(required ? { required: true } : {}),
    ...(sortOrder !== undefined ? { sortOrder } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

/** Парсит `properties_json` шаблона номенклатуры в упорядоченный список. */
export function parseTemplatePropertiesJson(raw: string | null | undefined): WarehouseNomenclatureTemplateProperty[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: WarehouseNomenclatureTemplateProperty[] = [];
    for (const item of parsed) {
      const row = normalizeRow(item);
      if (row) out.push(row);
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeTemplatePropertiesJson(rows: WarehouseNomenclatureTemplateProperty[]): string {
  const cleaned = rows.map((r, index) => {
    const propertyId = String(r.propertyId ?? '').trim();
    const sortOrder = r.sortOrder ?? index * 10;
    return {
      propertyId,
      ...(r.required ? { required: true } : {}),
      sortOrder,
      ...(r.defaultValue !== undefined ? { defaultValue: r.defaultValue } : {}),
    };
  });
  return JSON.stringify(cleaned);
}

export function appendTemplateProperty(
  rows: WarehouseNomenclatureTemplateProperty[],
  propertyId: string,
  opts?: { required?: boolean },
): WarehouseNomenclatureTemplateProperty[] {
  const id = String(propertyId ?? '').trim();
  if (!id) return rows;
  if (rows.some((r) => r.propertyId === id)) return rows;
  return [...rows, { propertyId: id, required: opts?.required === true, sortOrder: rows.length * 10 }];
}

export function removeTemplateProperty(rows: WarehouseNomenclatureTemplateProperty[], propertyId: string): WarehouseNomenclatureTemplateProperty[] {
  const id = String(propertyId ?? '').trim();
  return rows.filter((r) => r.propertyId !== id);
}

export function setTemplatePropertyRequired(
  rows: WarehouseNomenclatureTemplateProperty[],
  propertyId: string,
  required: boolean,
): WarehouseNomenclatureTemplateProperty[] {
  const id = String(propertyId ?? '').trim();
  return rows.map((r) => (r.propertyId === id ? { ...r, required } : r));
}

export function moveTemplateProperty(rows: WarehouseNomenclatureTemplateProperty[], from: number, to: number): WarehouseNomenclatureTemplateProperty[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows;
  const next = [...rows];
  const [item] = next.splice(from, 1);
  if (!item) return rows;
  next.splice(to, 0, item);
  return next.map((r, index) => ({ ...r, sortOrder: index * 10 }));
}

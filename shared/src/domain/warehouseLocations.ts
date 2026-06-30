/**
 * Convention-based naming for logical warehouse locations used by the
 * parts-movement / engine-assembly module.
 *
 * `warehouseId` in the schema is a free-form text column; the strings below
 * are the canonical identifiers shared across services, UI and reports.
 */

export const WAREHOUSE_LOCATION_REPAIR_FUND = 'repair_fund' as const;
export const WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS = 'assembly_in_progress' as const;
export const WAREHOUSE_LOCATION_SCRAP = 'scrap' as const;
export const WAREHOUSE_LOCATION_DEFAULT = 'default' as const;

export const WORKSHOP_WAREHOUSE_PREFIX = 'workshop_' as const;

export function workshopWarehouseId(code: string | number): string {
  return `${WORKSHOP_WAREHOUSE_PREFIX}${String(code).trim()}`;
}

const WORKSHOP_WAREHOUSE_RE = /^workshop_([0-9a-zA-Z_-]+)$/;

export function parseWorkshopWarehouseId(warehouseId: string | null | undefined): string | null {
  if (!warehouseId) return null;
  const match = WORKSHOP_WAREHOUSE_RE.exec(String(warehouseId).trim());
  return match ? (match[1] ?? null) : null;
}

export function isWorkshopWarehouseId(warehouseId: string | null | undefined): boolean {
  return parseWorkshopWarehouseId(warehouseId) !== null;
}

export const SYSTEM_WAREHOUSE_LOCATIONS = [
  WAREHOUSE_LOCATION_REPAIR_FUND,
  WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS,
  WAREHOUSE_LOCATION_SCRAP,
] as const;

export const WAREHOUSE_LOCATION_LABELS: Record<string, string> = {
  [WAREHOUSE_LOCATION_REPAIR_FUND]: 'Ремонтный фонд',
  [WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS]: 'В сборке',
  [WAREHOUSE_LOCATION_SCRAP]: 'Утиль',
  [WAREHOUSE_LOCATION_DEFAULT]: 'Основной склад',
};

export function warehouseLocationLabel(warehouseId: string | null | undefined, workshopName?: string | null): string {
  const id = String(warehouseId ?? '').trim();
  if (!id) return '—';
  const known = WAREHOUSE_LOCATION_LABELS[id];
  if (known) return known;
  const workshopCode = parseWorkshopWarehouseId(id);
  if (workshopCode) {
    const trimmed = (workshopName ?? '').trim();
    return trimmed ? `Цех ${trimmed}` : `Цех ${workshopCode}`;
  }
  return id;
}

export type AttributeDefRow = {
  id: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  metaJson?: unknown;
};

export type EnsureFieldInput = {
  code: string;
  name: string;
  dataType: string;
  isRequired?: boolean;
  sortOrder?: number;
  metaJson?: string | null;
};

export function orderFieldsByDefs<T extends { code: string; defaultOrder?: number }>(items: T[], defs: AttributeDefRow[]): T[] {
  const orderByCode = new Map(defs.map((d) => [d.code, d.sortOrder]));
  return [...items].sort((a, b) => {
    const ao = orderByCode.get(a.code);
    const bo = orderByCode.get(b.code);
    const aOrder = ao ?? a.defaultOrder ?? 0;
    const bOrder = bo ?? b.defaultOrder ?? 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.code.localeCompare(b.code);
  });
}

export function nextSortOrder(idx: number, startAt = 10) {
  return startAt + idx * 10;
}

export async function ensureAttributeDefs(
  entityTypeId: string,
  desired: EnsureFieldInput[],
  existing: AttributeDefRow[],
): Promise<AttributeDefRow[]> {
  const byCode = new Map(existing.map((d) => [d.code, d]));
  const created: AttributeDefRow[] = [];

  for (const field of desired) {
    if (byCode.has(field.code)) continue;
    const r = await window.matrica.admin.attributeDefs.upsert({
      entityTypeId,
      code: field.code,
      name: field.name,
      dataType: field.dataType,
      isRequired: field.isRequired ?? false,
      sortOrder: field.sortOrder ?? 0,
      metaJson: field.metaJson ?? null,
    });
    if (r?.ok && r?.id) {
      created.push({
        id: String(r.id),
        entityTypeId,
        code: field.code,
        name: field.name,
        dataType: field.dataType,
        isRequired: field.isRequired ?? false,
        sortOrder: field.sortOrder ?? 0,
        metaJson: field.metaJson ?? null,
      });
    }
  }

  return [...existing, ...created];
}

export async function persistFieldOrder(
  orderedCodes: string[],
  defs: AttributeDefRow[],
  opts?: { entityTypeId?: string; startAt?: number },
): Promise<void> {
  const byCode = new Map(defs.map((d) => [d.code, d]));
  const base = opts?.startAt ?? 10;
  const updates = orderedCodes
    .map((code, idx) => ({ def: byCode.get(code), sortOrder: nextSortOrder(idx, base) }))
    .filter((u) => u.def);

  for (const item of updates) {
    const def = item.def!;
    if (def.sortOrder === item.sortOrder) continue;
    await window.matrica.admin.attributeDefs.upsert({
      id: def.id,
      entityTypeId: def.entityTypeId ?? opts?.entityTypeId,
      code: def.code,
      name: def.name,
      dataType: def.dataType,
      isRequired: def.isRequired,
      sortOrder: item.sortOrder,
      metaJson: def.metaJson ? (typeof def.metaJson === 'string' ? def.metaJson : JSON.stringify(def.metaJson)) : null,
    });
    def.sortOrder = item.sortOrder;
  }
}

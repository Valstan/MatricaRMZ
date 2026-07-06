export type EngineBomLine = {
  id?: string;
  componentNomenclatureId: string;
  componentType: string;
  qtyPerUnit: number;
  variantGroup?: string | null;
  lineKey?: string | null;
  parentLineKey?: string | null;
  isRequired: boolean;
  priority: number;
  notes?: string | null;
  positionKey?: string | null;
  positionLabel?: string | null;
  isDefaultOption?: boolean;
};

export type EngineBomDetailsForSnapshot = {
  header: {
    id: string;
    name: string;
    engineBrandIds: string[];
    status: string;
    isDefault: boolean;
    notes?: string | null;
  };
  lines: EngineBomLine[];
};

export type MissingComponentTypeEntry = {
  scope: string;
  scopeTitle: string;
  missingTypeIds: string[];
};

export function normalizeNodeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
}

export function normalizeVariantGroup(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  return value || null;
}

// Snapshot для dirty-detection. С v1.21.5 `priority` снова в snapshot —
// backend больше не пересчитывает его при save. `version` остаётся исключённым:
// server bump'ает version при каждом save, иначе snapshot после refresh всегда отличался бы.
export function buildBomSnapshot(data: EngineBomDetailsForSnapshot | null): string {
  if (!data) return '';
  return JSON.stringify({
    header: {
      id: data.header.id,
      name: data.header.name,
      engineBrandIds: [...(data.header.engineBrandIds ?? [])].sort(),
      status: data.header.status,
      isDefault: data.header.isDefault,
      notes: data.header.notes ?? null,
    },
    lines: data.lines.map((line) => ({
      id: line.id ?? '',
      componentNomenclatureId: line.componentNomenclatureId,
      componentType: line.componentType,
      qtyPerUnit: Number(line.qtyPerUnit ?? 0),
      variantGroup: line.variantGroup ?? null,
      lineKey: normalizeNodeKey(String(line.lineKey ?? '')) || null,
      parentLineKey: normalizeNodeKey(String(line.parentLineKey ?? '')) || null,
      isRequired: line.isRequired !== false,
      priority: Math.max(0, Math.trunc(Number(line.priority ?? 100))),
      notes: line.notes ?? null,
      positionKey: line.positionKey ?? null,
      positionLabel: line.positionLabel ?? null,
      isDefaultOption: line.isDefaultOption !== false,
    })),
  });
}

// Чистый расчёт «чего не хватает» по глобальной схеме. БЕЗ мутации data.
// Возвращает по одной записи на scope (base или __kit_*) с типами, которых не хватает.
// Если есть хоть один __kit_-вариант — base scope не проверяется (variant покрывает требования).
export function computeMissingComponentTypes(
  data: { lines: EngineBomLine[] } | null,
  requiredComponentTypes: string[],
  scopeTitleFor: (scope: string) => string = (scope) => (scope === '__base__' ? 'Общая спецификация' : `Вариант ${scope}`),
): MissingComponentTypeEntry[] {
  if (!data) return [];
  if (requiredComponentTypes.length === 0) return [];
  const existingLines = data.lines;
  if (existingLines.length === 0) {
    return [{ scope: '__base__', scopeTitle: scopeTitleFor('__base__'), missingTypeIds: [...requiredComponentTypes] }];
  }
  const byScope = new Map<string, EngineBomLine[]>();
  for (const line of existingLines) {
    const scope = normalizeVariantGroup(line.variantGroup) || '__base__';
    const list = byScope.get(scope) ?? [];
    list.push(line);
    byScope.set(scope, list);
  }
  const scopes = Array.from(byScope.keys());
  const onlyBase = scopes.length === 1 && scopes[0] === '__base__';
  const normalizedRequired = requiredComponentTypes.map((typeId) => String(typeId).trim().toLowerCase()).filter(Boolean);
  const result: MissingComponentTypeEntry[] = [];
  if (onlyBase) {
    const presentTypes = new Set(existingLines.map((line) => String(line.componentType ?? '').trim().toLowerCase()).filter(Boolean));
    const missing = normalizedRequired.filter((typeId) => !presentTypes.has(typeId));
    if (missing.length > 0) result.push({ scope: '__base__', scopeTitle: scopeTitleFor('__base__'), missingTypeIds: missing });
  } else {
    for (const scope of scopes) {
      if (scope === '__base__') continue;
      if (!scope.startsWith('__kit_')) continue;
      const scopeLines = byScope.get(scope) ?? [];
      const presentTypes = new Set(scopeLines.map((line) => String(line.componentType ?? '').trim().toLowerCase()).filter(Boolean));
      const missing = normalizedRequired.filter((typeId) => !presentTypes.has(typeId));
      if (missing.length > 0) result.push({ scope, scopeTitle: scopeTitleFor(scope), missingTypeIds: missing });
    }
  }
  return result;
}

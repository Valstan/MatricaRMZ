export type EngineBomLine = {
  id?: string;
  componentNomenclatureId: string;
  componentNomenclatureCode?: string | null;
  componentNomenclatureName?: string | null;
  componentType: string;
  qtyPerUnit: number;
  variantGroup?: string | null;
  lineKey?: string | null;
  parentLineKey?: string | null;
  isRequired: boolean;
  priority: number;
  notes?: string | null;
  /** Норма расхода, %. С E1 редактируется в карточке — значит, обязана быть в снапшоте. */
  normPercent?: number | null;
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
    /** Марки, для которых эта BOM — основная (подмножество `engineBrandIds`). */
    defaultForBrandIds?: string[] | null;
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
/**
 * Переключить «эта BOM — основная для марки». Порядок не значим (сервер хранит флаг на связке),
 * поэтому дубли не копим: сначала выкидываем, потом при включении добавляем один раз.
 */
export function toggleDefaultForBrand(current: readonly string[] | null | undefined, brandId: string, on: boolean): string[] {
  const without = [...(current ?? [])].filter((id) => id !== brandId);
  return on ? [...without, brandId] : without;
}

/**
 * Снятая марка не может остаться «основной»: сервер отвергает весь upsert, если
 * `defaultForBrandIds` не подмножество `engineBrandIds`.
 */
export function pruneDefaultForBrands(current: readonly string[] | null | undefined, engineBrandIds: readonly string[]): string[] {
  return [...(current ?? [])].filter((id) => engineBrandIds.includes(id));
}

export function buildBomSnapshot(data: EngineBomDetailsForSnapshot | null): string {
  if (!data) return '';
  return JSON.stringify({
    header: {
      id: data.header.id,
      name: data.header.name,
      engineBrandIds: [...(data.header.engineBrandIds ?? [])].sort(),
      status: data.header.status,
      isDefault: data.header.isDefault,
      // Без этого поля переключение «основная для марки» не помечает карточку грязной,
      // и правка молча теряется при закрытии — тот же класс, что GOTCHAS M53.
      defaultForBrandIds: [...(data.header.defaultForBrandIds ?? [])].sort(),
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
      normPercent: line.normPercent ?? null,
      positionKey: line.positionKey ?? null,
      positionLabel: line.positionLabel ?? null,
      isDefaultOption: line.isDefaultOption !== false,
    })),
  });
}

/**
 * «Привязать ко всем маркам группы»: марки группы добавляются к марками BOM без дублей и
 * без изменения порядка уже выбранных. Возвращает и число добавленных — для сообщения оператору.
 */
export function addBrandGroupToBom(current: readonly string[], groupBrandIds: readonly string[]): { engineBrandIds: string[]; added: number } {
  const have = new Set(current.map(String));
  const out = [...current.map(String)];
  let added = 0;
  for (const raw of groupBrandIds) {
    const id = String(raw ?? '').trim();
    if (!id || have.has(id)) continue;
    have.add(id);
    out.push(id);
    added += 1;
  }
  return { engineBrandIds: out, added };
}

export const BOM_BASE_SCOPE = '__base__';

/** Ключ комплекта-варианта (`__kit_<hex>`): внутренний, оператору показывается как «Вариант N». */
export function genBomKitKey(random: () => number = Math.random): string {
  return `__kit_${random().toString(36).slice(2, 10)}`;
}

/** Комплекты BOM в порядке показа: база всегда первой, киты — по ключу. */
export function listBomScopes(lines: readonly EngineBomLine[]): string[] {
  const kits = new Set<string>();
  for (const line of lines) {
    const vg = normalizeVariantGroup(line.variantGroup);
    if (vg) kits.add(vg);
  }
  return [BOM_BASE_SCOPE, ...Array.from(kits).sort((a, b) => a.localeCompare(b, 'ru'))];
}

export type BomCardPosition = {
  /** Ключ позиции (`positionKey`) либо `solo-<idx>` для строки без позиции. */
  posKey: string;
  /** Индекс основной строки в `lines`. */
  primaryIdx: number;
  /** Индексы запасных вариантов (isDefaultOption=false) в порядке появления. */
  backupIdxs: number[];
};

export type BomCardSection = {
  typeId: string;
  positions: BomCardPosition[];
};

/**
 * Раскладка карточки: строки одного комплекта → разделы по типу компонента → позиции.
 * Порядок разделов — по `typeOrder` (sortOrder схемы), незнакомые типы — в конец по алфавиту;
 * внутри раздела — по `priority`, затем по подписи. Тип позиции берётся у основной строки.
 */
export function groupBomLinesForCard(
  lines: readonly EngineBomLine[],
  scope: string,
  typeOrder: ReadonlyMap<string, number>,
  labelOf: (line: EngineBomLine) => string = (line) => line.componentNomenclatureId,
): BomCardSection[] {
  const byPos = new Map<string, BomCardPosition>();
  const order: string[] = [];
  lines.forEach((line, idx) => {
    if ((normalizeVariantGroup(line.variantGroup) ?? BOM_BASE_SCOPE) !== scope) return;
    const key = String(line.positionKey ?? '').trim();
    const posKey = key || `solo-${idx}`;
    let pos = byPos.get(posKey);
    if (!pos) {
      pos = { posKey, primaryIdx: idx, backupIdxs: [] };
      byPos.set(posKey, pos);
      order.push(posKey);
      if (line.isDefaultOption === false) pos.backupIdxs.push(idx);
      return;
    }
    if (line.isDefaultOption !== false && lines[pos.primaryIdx]!.isDefaultOption === false) {
      // Основная пришла после запасных: первая строка была временным primary.
      pos.backupIdxs = pos.backupIdxs.filter((i) => i !== pos!.primaryIdx);
      pos.backupIdxs.unshift(pos.primaryIdx);
      pos.primaryIdx = idx;
    } else {
      pos.backupIdxs.push(idx);
    }
  });

  const byType = new Map<string, BomCardPosition[]>();
  for (const posKey of order) {
    const pos = byPos.get(posKey)!;
    const typeId = String(lines[pos.primaryIdx]!.componentType ?? 'other').trim().toLowerCase() || 'other';
    const list = byType.get(typeId) ?? [];
    list.push(pos);
    byType.set(typeId, list);
  }
  const rank = (typeId: string) => typeOrder.get(typeId) ?? Number.MAX_SAFE_INTEGER;
  return Array.from(byType.entries())
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'ru'))
    .map(([typeId, positions]) => ({
      typeId,
      positions: [...positions].sort((a, b) => {
        const la = lines[a.primaryIdx]!;
        const lb = lines[b.primaryIdx]!;
        const pa = Number(la.priority ?? 100);
        const pb = Number(lb.priority ?? 100);
        if (pa !== pb) return pa - pb;
        return labelOf(la).localeCompare(labelOf(lb), 'ru');
      }),
    }));
}

/** Индексы строк, чья подпись/артикул содержит запрос (регистр не важен). Пустой запрос = все. */
export function filterBomLineIdxs(lines: readonly EngineBomLine[], query: string, textOf: (line: EngineBomLine) => string): Set<number> | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const out = new Set<number>();
  lines.forEach((line, idx) => {
    if (textOf(line).toLowerCase().includes(q)) out.add(idx);
  });
  return out;
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

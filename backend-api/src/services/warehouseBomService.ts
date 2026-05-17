import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';
import {
  buildEngineBomSkeletonBlockLines,
  DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA,
  normalizeBomRelationKey,
  sanitizeWarehouseBomRelationSchema,
  type WarehouseBomRelationSchema,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import {
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpNomenclatureEngineBrand,
  erpPlannedIncoming,
  erpRegStockBalance,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';
import { getGlobalWarehouseBomRelationSchema } from './clientSettingsService.js';
import { parseWarehouseBomLineMeta, serializeWarehouseBomLineMeta } from './warehouseBomLineMeta.js';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type Actor = { id: string; username: string; role?: string };

function nowMs() {
  return Date.now();
}

function normalizeStatus(raw: string | undefined): 'draft' | 'active' | 'archived' {
  const value = String(raw ?? 'draft').trim().toLowerCase();
  if (value === 'active' || value === 'archived') return value;
  return 'draft';
}

function normalizeComponentType(raw: string | undefined): 'sleeve' | 'piston' | 'ring' | 'jacket' | 'head' | 'carter' | 'other' {
  const value = String(raw ?? 'other').trim().toLowerCase();
  if (value === 'sleeve' || value === 'piston' || value === 'ring' || value === 'jacket' || value === 'head' || value === 'carter') return value;
  return 'other';
}

const KNOWN_COMPONENT_TYPES = new Set(['sleeve', 'piston', 'ring', 'jacket', 'head', 'carter', 'other']);

/** typeId -> sortOrder из глобальной схемы; fallback = 100 для неизвестных типов. */
function buildSchemaSortOrderMap(schema: WarehouseBomRelationSchema): Map<string, number> {
  const map = new Map<string, number>();
  for (const node of schema.nodes) {
    if (node && node.typeId) map.set(String(node.typeId).trim().toLowerCase(), Number(node.sortOrder ?? 100));
  }
  return map;
}

function schemaPriorityFor(sortOrderMap: Map<string, number>, componentType: string): number {
  return sortOrderMap.get(String(componentType).trim().toLowerCase()) ?? 100;
}

function variantScopeKey(v: string | null | undefined): string {
  const s = String(v ?? '').trim();
  return s.length > 0 ? s : '__base__';
}

async function loadSanitizedBomRelationSchema(): Promise<WarehouseBomRelationSchema> {
  try {
    const value = await getGlobalWarehouseBomRelationSchema();
    return sanitizeWarehouseBomRelationSchema(JSON.parse(value.schemaJson) as unknown);
  } catch {
    return DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA;
  }
}

/** Legacy-колонка `engine_nomenclature_id`: только тип engine, привязанный к марке (если ведёте такие позиции). */
async function pickEngineNomenclatureIdForBrand(engineBrandId: string): Promise<string | null> {
  const brand = String(engineBrandId).trim();
  if (!brand) return null;
  const enginePred = or(eq(erpNomenclature.itemType, 'engine'), eq(erpNomenclature.category, 'engine'));
  const byDefault = await db
    .select({ id: erpNomenclature.id })
    .from(erpNomenclature)
    .where(and(eq(erpNomenclature.defaultBrandId, brand), isNull(erpNomenclature.deletedAt), enginePred))
    .orderBy(asc(erpNomenclature.name))
    .limit(1);
  if (byDefault[0]?.id) return String(byDefault[0].id);
  const byJunction = await db
    .select({ id: erpNomenclature.id })
    .from(erpNomenclature)
    .innerJoin(erpNomenclatureEngineBrand, eq(erpNomenclatureEngineBrand.nomenclatureId, erpNomenclature.id))
    .where(
      and(
        eq(erpNomenclatureEngineBrand.engineBrandId, brand),
        isNull(erpNomenclatureEngineBrand.deletedAt),
        isNull(erpNomenclature.deletedAt),
        enginePred,
      ),
    )
    .orderBy(desc(erpNomenclatureEngineBrand.isDefault), asc(erpNomenclature.name))
    .limit(1);
  return byJunction[0]?.id ? String(byJunction[0].id) : null;
}

/**
 * Техническая заглушка для component_nomenclature_id в черновых строках BOM (FK в номенклатуру).
 * Смысловая привязка BOM к марке — только `engine_brand_id`; здесь нужен любой существующий id.
 */
async function pickLineDraftStubNomenclatureId(engineBrandId: string): Promise<string | null> {
  const engineStub = await pickEngineNomenclatureIdForBrand(engineBrandId);
  if (engineStub) return engineStub;

  const brand = String(engineBrandId).trim();
  if (!brand) return null;

  const anyByDefaultBrand = await db
    .select({ id: erpNomenclature.id })
    .from(erpNomenclature)
    .where(and(eq(erpNomenclature.defaultBrandId, brand), isNull(erpNomenclature.deletedAt)))
    .orderBy(asc(erpNomenclature.name))
    .limit(1);
  if (anyByDefaultBrand[0]?.id) return String(anyByDefaultBrand[0].id);

  const byJunctionAny = await db
    .select({ id: erpNomenclature.id })
    .from(erpNomenclature)
    .innerJoin(erpNomenclatureEngineBrand, eq(erpNomenclatureEngineBrand.nomenclatureId, erpNomenclature.id))
    .where(
      and(
        eq(erpNomenclatureEngineBrand.engineBrandId, brand),
        isNull(erpNomenclatureEngineBrand.deletedAt),
        isNull(erpNomenclature.deletedAt),
      ),
    )
    .orderBy(desc(erpNomenclatureEngineBrand.isDefault), asc(erpNomenclature.name))
    .limit(1);
  if (byJunctionAny[0]?.id) return String(byJunctionAny[0].id);

  const anyActive = await db
    .select({ id: erpNomenclature.id })
    .from(erpNomenclature)
    .where(isNull(erpNomenclature.deletedAt))
    .orderBy(asc(erpNomenclature.name))
    .limit(1);
  return anyActive[0]?.id ? String(anyActive[0].id) : null;
}

type BomLineInput = {
  id?: string;
  componentNomenclatureId: string;
  componentType?: string;
  qtyPerUnit: number;
  variantGroup?: string | null;
  lineKey?: string | null;
  parentLineKey?: string | null;
  isRequired?: boolean;
  priority?: number;
  notes?: string | null;
};

/** Загружает марки двигателей для набора BOM (через junction-таблицу). */
async function loadBrandIdsForBoms(bomIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (bomIds.length === 0) return result;
  const links = await db
    .select({
      bomId: erpEngineAssemblyBomBrandLinks.bomId,
      engineBrandId: erpEngineAssemblyBomBrandLinks.engineBrandId,
      isPrimary: erpEngineAssemblyBomBrandLinks.isPrimary,
      createdAt: erpEngineAssemblyBomBrandLinks.createdAt,
    })
    .from(erpEngineAssemblyBomBrandLinks)
    .where(
      and(
        inArray(erpEngineAssemblyBomBrandLinks.bomId, bomIds as any),
        isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
      ),
    )
    .orderBy(desc(erpEngineAssemblyBomBrandLinks.isPrimary), asc(erpEngineAssemblyBomBrandLinks.createdAt));
  for (const link of links) {
    const key = String(link.bomId);
    const arr = result.get(key) ?? [];
    arr.push(String(link.engineBrandId));
    result.set(key, arr);
  }
  return result;
}

export async function listWarehouseAssemblyBoms(args?: {
  engineBrandId?: string;
  engineBrandIds?: string[];
  /** Совместимость: фильтр по старой колонке, если ещё заполнена. */
  engineNomenclatureId?: string;
  status?: string;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const conditions = [isNull(erpEngineAssemblyBom.deletedAt)];
    const filterBrandIds = Array.isArray(args?.engineBrandIds)
      ? args.engineBrandIds.map(String).map((id) => id.trim()).filter(Boolean)
      : args?.engineBrandId
        ? [String(args.engineBrandId).trim()].filter(Boolean)
        : [];

    if (filterBrandIds.length > 0) {
      // Подзапрос: bom_id'ы, у которых есть активная связь с любой из переданных марок
      const matchingBomIds = await db
        .selectDistinct({ bomId: erpEngineAssemblyBomBrandLinks.bomId })
        .from(erpEngineAssemblyBomBrandLinks)
        .where(
          and(
            inArray(erpEngineAssemblyBomBrandLinks.engineBrandId, filterBrandIds as any),
            isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
          ),
        );
      const ids = matchingBomIds.map((row) => String(row.bomId));
      if (ids.length === 0) return { ok: true, rows: [] };
      conditions.push(inArray(erpEngineAssemblyBom.id, ids as any));
    }

    if (args?.engineNomenclatureId) {
      conditions.push(eq(erpEngineAssemblyBom.engineNomenclatureId, String(args.engineNomenclatureId)));
    }
    if (args?.status) {
      conditions.push(eq(erpEngineAssemblyBom.status, normalizeStatus(args.status)));
    } else {
      conditions.push(eq(erpEngineAssemblyBom.status, 'active'));
    }
    const headerRows = await db
      .select({
        id: erpEngineAssemblyBom.id,
        name: erpEngineAssemblyBom.name,
        engineNomenclatureId: erpEngineAssemblyBom.engineNomenclatureId,
        version: erpEngineAssemblyBom.version,
        status: erpEngineAssemblyBom.status,
        isDefault: erpEngineAssemblyBom.isDefault,
        notes: erpEngineAssemblyBom.notes,
        createdAt: erpEngineAssemblyBom.createdAt,
        updatedAt: erpEngineAssemblyBom.updatedAt,
        deletedAt: erpEngineAssemblyBom.deletedAt,
        engineCode: erpNomenclature.code,
        engineName: erpNomenclature.name,
      })
      .from(erpEngineAssemblyBom)
      .leftJoin(erpNomenclature, eq(erpNomenclature.id, erpEngineAssemblyBom.engineNomenclatureId))
      .where(and(...conditions))
      .orderBy(desc(erpEngineAssemblyBom.updatedAt), desc(erpEngineAssemblyBom.version));

    const bomIds = headerRows.map((row) => String(row.id));
    const lineCounts = new Map<string, number>();
    if (bomIds.length > 0) {
      const grouped = await db
        .select({
          bomId: erpEngineAssemblyBomLines.bomId,
          count: sql<number>`count(*)`,
        })
        .from(erpEngineAssemblyBomLines)
        .where(and(inArray(erpEngineAssemblyBomLines.bomId, bomIds as any), isNull(erpEngineAssemblyBomLines.deletedAt)))
        .groupBy(erpEngineAssemblyBomLines.bomId);
      for (const row of grouped) {
        lineCounts.set(String(row.bomId), Number(row.count ?? 0));
      }
    }
    const brandIdsMap = await loadBrandIdsForBoms(bomIds);

    return {
      ok: true,
      rows: headerRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        engineBrandIds: brandIdsMap.get(String(row.id)) ?? [],
        engineNomenclatureId: row.engineNomenclatureId ? String(row.engineNomenclatureId) : null,
        engineNomenclatureCode: row.engineCode ? String(row.engineCode) : null,
        engineNomenclatureName: row.engineName ? String(row.engineName) : null,
        version: Number(row.version ?? 1),
        status: String(row.status),
        isDefault: Boolean(row.isDefault),
        notes: row.notes ?? null,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
        linesCount: lineCounts.get(String(row.id)) ?? 0,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function loadBomDetailsById(id: string): Promise<Result<{ bom: { header: Record<string, unknown>; lines: Array<Record<string, unknown>> } }>> {
  const bomId = String(id);
  const headerRows = await db
    .select({
      id: erpEngineAssemblyBom.id,
      name: erpEngineAssemblyBom.name,
      engineNomenclatureId: erpEngineAssemblyBom.engineNomenclatureId,
      version: erpEngineAssemblyBom.version,
      status: erpEngineAssemblyBom.status,
      isDefault: erpEngineAssemblyBom.isDefault,
      notes: erpEngineAssemblyBom.notes,
      createdAt: erpEngineAssemblyBom.createdAt,
      updatedAt: erpEngineAssemblyBom.updatedAt,
      deletedAt: erpEngineAssemblyBom.deletedAt,
      engineCode: erpNomenclature.code,
      engineName: erpNomenclature.name,
    })
    .from(erpEngineAssemblyBom)
    .leftJoin(erpNomenclature, eq(erpNomenclature.id, erpEngineAssemblyBom.engineNomenclatureId))
    .where(and(eq(erpEngineAssemblyBom.id, bomId), isNull(erpEngineAssemblyBom.deletedAt)))
    .limit(1);

  const hr = headerRows[0];
  if (!hr) return { ok: false, error: 'BOM не найден' };
  const brandIdsMap = await loadBrandIdsForBoms([bomId]);
  const header: Record<string, unknown> = {
    id: String(hr.id),
    name: String(hr.name),
    engineBrandIds: brandIdsMap.get(bomId) ?? [],
    engineNomenclatureId: hr.engineNomenclatureId ? String(hr.engineNomenclatureId) : null,
    engineNomenclatureCode: hr.engineCode ? String(hr.engineCode) : null,
    engineNomenclatureName: hr.engineName ? String(hr.engineName) : null,
    version: Number(hr.version ?? 1),
    status: String(hr.status),
    isDefault: Boolean(hr.isDefault),
    notes: hr.notes ?? null,
    createdAt: Number(hr.createdAt),
    updatedAt: Number(hr.updatedAt),
    deletedAt: hr.deletedAt == null ? null : Number(hr.deletedAt),
  };

  const lines = await db
    .select({
      id: erpEngineAssemblyBomLines.id,
      bomId: erpEngineAssemblyBomLines.bomId,
      componentNomenclatureId: erpEngineAssemblyBomLines.componentNomenclatureId,
      componentNomenclatureCode: erpNomenclature.code,
      componentNomenclatureName: erpNomenclature.name,
      componentType: erpEngineAssemblyBomLines.componentType,
      qtyPerUnit: erpEngineAssemblyBomLines.qtyPerUnit,
      variantGroup: erpEngineAssemblyBomLines.variantGroup,
      isRequired: erpEngineAssemblyBomLines.isRequired,
      priority: erpEngineAssemblyBomLines.priority,
      notes: erpEngineAssemblyBomLines.notes,
      createdAt: erpEngineAssemblyBomLines.createdAt,
      updatedAt: erpEngineAssemblyBomLines.updatedAt,
      deletedAt: erpEngineAssemblyBomLines.deletedAt,
    })
    .from(erpEngineAssemblyBomLines)
    .leftJoin(erpNomenclature, eq(erpNomenclature.id, erpEngineAssemblyBomLines.componentNomenclatureId))
    .where(and(eq(erpEngineAssemblyBomLines.bomId, bomId), isNull(erpEngineAssemblyBomLines.deletedAt)))
    .orderBy(asc(erpEngineAssemblyBomLines.priority), asc(erpEngineAssemblyBomLines.createdAt));

  const parsedLineMeta = new Map<string, ReturnType<typeof parseWarehouseBomLineMeta>>();
  for (const row of lines) {
    parsedLineMeta.set(String(row.id), parseWarehouseBomLineMeta(row.notes));
  }

  return {
    ok: true,
    bom: {
      header,
      lines: lines.map((row) => ({
        id: String(row.id),
        bomId: String(row.bomId),
        componentNomenclatureId: String(row.componentNomenclatureId),
        componentNomenclatureCode: row.componentNomenclatureCode ? String(row.componentNomenclatureCode) : null,
        componentNomenclatureName: row.componentNomenclatureName ? String(row.componentNomenclatureName) : null,
        componentType: String(row.componentType),
        qtyPerUnit: Number(row.qtyPerUnit ?? 0),
        variantGroup: row.variantGroup ?? null,
        lineKey: parsedLineMeta.get(String(row.id))?.lineKey ?? null,
        parentLineKey: parsedLineMeta.get(String(row.id))?.parentLineKey ?? null,
        isRequired: Boolean(row.isRequired),
        priority: Number(row.priority ?? 100),
        notes: parsedLineMeta.get(String(row.id))?.text ?? null,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
      })),
    },
  };
}

export async function getWarehouseAssemblyBom(args: { id: string }): Promise<Result<{ bom: { header: Record<string, unknown>; lines: Array<Record<string, unknown>> } }>> {
  try {
    return await loadBomDetailsById(String(args.id));
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseAssemblyBom(args: {
  id?: string;
  name: string;
  /** Список марок двигателей, к которым применима спецификация (минимум одна). */
  engineBrandIds: string[];
  /** Опционально: legacy-колонка — номенклатура типа engine для марки; иначе null. Черновые строки используют отдельный resolve. */
  engineNomenclatureId?: string | null;
  version?: number;
  status?: string;
  isDefault?: boolean;
  notes?: string | null;
  lines: BomLineInput[];
  actor: Actor;
}): Promise<Result<{ id: string }>> {
  try {
    const requestedBrandIds = Array.from(
      new Set(
        (Array.isArray(args.engineBrandIds) ? args.engineBrandIds : [])
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
    if (requestedBrandIds.length === 0) {
      return { ok: false, error: 'Не указана ни одна марка двигателя (engineBrandIds)' };
    }
    const primaryBrandId = requestedBrandIds[0]!;
    const id = String(args.id ?? randomUUID());

    const ts = nowMs();
    const status = 'active';
    const version = Math.max(1, Math.trunc(Number(args.version ?? 1)));
    const lineStubId = await pickLineDraftStubNomenclatureId(primaryBrandId);
    if (!lineStubId) {
      return {
        ok: false,
        error:
          'В номенклатуре склада нет ни одной активной позиции — для черновых строк BOM нужен валидный идентификатор (техническая заглушка). Добавьте хотя бы одну позицию в номенклатуру и повторите.',
      };
    }
    const explicitNom = args.engineNomenclatureId != null && String(args.engineNomenclatureId).trim() ? String(args.engineNomenclatureId).trim() : null;
    const headerEngineNom = explicitNom ?? (await pickEngineNomenclatureIdForBrand(primaryBrandId));
    const base = {
      name: String(args.name ?? '').trim() || `BOM ${version}`,
      engineNomenclatureId: headerEngineNom,
      version,
      status,
      isDefault: true,
      notes: args.notes == null ? null : String(args.notes),
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced' as const,
    };

    await db
      .insert(erpEngineAssemblyBom)
      .values({
        id,
        ...base,
        createdAt: ts,
        lastServerSeq: null,
      })
      .onConflictDoUpdate({
        target: erpEngineAssemblyBom.id,
        set: {
          ...base,
        },
      });

    const sanitizedSchema = await loadSanitizedBomRelationSchema();
    let sourceLines = Array.isArray(args.lines) ? args.lines : [];
    if (sourceLines.length === 0) {
      const blockToken = randomUUID().replace(/-/g, '');
      const variantGroupId = `__kit_${blockToken.slice(0, 12)}`;
      const lineKeyPrefix = `b${blockToken.slice(0, 10)}`;
      sourceLines = buildEngineBomSkeletonBlockLines({
        stubComponentNomenclatureId: lineStubId,
        schema: sanitizedSchema,
        variantGroupId,
        lineKeyPrefix,
      });
    }

    const schemaSortOrderMap = buildSchemaSortOrderMap(sanitizedSchema);
    const normalizedLines = sourceLines
      .map((line) => {
        const componentType = normalizeComponentType(line.componentType);
        return {
        id: randomUUID(),
        bomId: id,
        componentNomenclatureId: String(line.componentNomenclatureId),
        componentType,
        qtyPerUnit: Math.max(0, Math.trunc(Number(line.qtyPerUnit ?? 0))),
        variantGroup: line.variantGroup == null ? null : String(line.variantGroup).trim() || null,
        lineKey: normalizeBomRelationKey(line.lineKey == null ? null : String(line.lineKey)),
        parentLineKey: normalizeBomRelationKey(line.parentLineKey == null ? null : String(line.parentLineKey)),
        isRequired: line.isRequired !== false,
        priority: schemaPriorityFor(schemaSortOrderMap, componentType),
        notesText: line.notes == null ? null : String(line.notes),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced' as const,
        lastServerSeq: null,
        };
      })
      .filter((line) => line.componentNomenclatureId);

    const rootId = String(sanitizedSchema.rootTypeId ?? 'engine').trim().toLowerCase();
    const requiredTypes = new Set(
      sanitizedSchema.nodes
        .filter((node) => node && node.isActive !== false)
        .map((node) => String(node.typeId ?? '').trim().toLowerCase())
        .filter((typeId) => typeId && typeId !== rootId && KNOWN_COMPONENT_TYPES.has(typeId)),
    );
    // Пустую карточку BOM (ещё без строк) можно создать и постепенно заполнять; полнота по схеме проверяется, когда уже есть строки.
    const linesByVariantScope = new Map<string, typeof normalizedLines>();
    for (const line of normalizedLines) {
      const sk = variantScopeKey(line.variantGroup);
      const arr = linesByVariantScope.get(sk) ?? [];
      arr.push(line);
      linesByVariantScope.set(sk, arr);
    }
    if (requiredTypes.size > 0 && normalizedLines.length > 0) {
      const onlyBase = linesByVariantScope.size === 1 && linesByVariantScope.has('__base__');
      if (onlyBase) {
        const presentTypes = new Set(normalizedLines.map((line) => String(line.componentType ?? '').trim().toLowerCase()).filter(Boolean));
        const missingTypes = Array.from(requiredTypes).filter((requiredType) => !presentTypes.has(requiredType));
        if (missingTypes.length > 0) {
          return {
            ok: false,
            error: `BOM не сохранен: отсутствуют обязательные типы из глобальной схемы: ${missingTypes.join(', ')}`,
          };
        }
      } else {
        for (const [scope, scopeLines] of linesByVariantScope) {
          if (scope === '__base__') continue;
          if (scopeLines.length === 0) continue;
          // Старые черновики с отдельным variantGroup на каждую строку (__bom_init__*) не требуют полного набора в каждой «подгруппе».
          if (!scope.startsWith('__kit_')) continue;
          const presentTypes = new Set(scopeLines.map((line) => String(line.componentType ?? '').trim().toLowerCase()).filter(Boolean));
          const missingTypes = Array.from(requiredTypes).filter((requiredType) => !presentTypes.has(requiredType));
          if (missingTypes.length > 0) {
            return {
              ok: false,
              error: `BOM не сохранен: в варианте «${scope}» отсутствуют обязательные типы из глобальной схемы: ${missingTypes.join(', ')}`,
            };
          }
        }
      }
    }

    const validationErrors: string[] = [];
    for (const [scope, scopeLines] of linesByVariantScope) {
      const keyCounts = new Map<string, number>();
      for (const line of scopeLines) {
        if (!line.lineKey) continue;
        keyCounts.set(line.lineKey, (keyCounts.get(line.lineKey) ?? 0) + 1);
      }
      const lineKeys = new Set(Array.from(keyCounts.keys()));
      for (const [key, count] of keyCounts.entries()) {
        if (count > 1) validationErrors.push(`вариант «${scope}»: дубли ключа узла "${key}"`);
      }
      for (const line of scopeLines) {
        if (line.parentLineKey && !line.lineKey) {
          validationErrors.push(`вариант «${scope}»: строка с родителем должна иметь собственный ключ узла`);
        }
        if (line.parentLineKey && !lineKeys.has(line.parentLineKey)) {
          validationErrors.push(`вариант «${scope}»: родительский узел "${line.parentLineKey}" не найден среди узлов этого варианта`);
        }
        if (line.lineKey && line.parentLineKey && line.lineKey === line.parentLineKey) {
          validationErrors.push(`вариант «${scope}»: узел "${line.lineKey}" не может ссылаться сам на себя`);
        }
      }
      const keyToParent = new Map<string, string | null>();
      for (const line of scopeLines) {
        if (!line.lineKey || (keyCounts.get(line.lineKey) ?? 0) > 1) continue;
        keyToParent.set(line.lineKey, line.parentLineKey ?? null);
      }
      for (const key of keyToParent.keys()) {
        const chain = new Set<string>();
        let current: string | null = key;
        while (current) {
          if (chain.has(current)) {
            validationErrors.push(
              `вариант «${scope}»: обнаружен цикл в связях BOM: ${Array.from(chain).join(' -> ')} -> ${current}`,
            );
            break;
          }
          chain.add(current);
          current = keyToParent.get(current) ?? null;
        }
      }
    }
    if (validationErrors.length > 0) {
      return { ok: false, error: `BOM не сохранен: ${Array.from(new Set(validationErrors)).join('; ')}` };
    }

    await db
      .update(erpEngineAssemblyBomLines)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(erpEngineAssemblyBomLines.bomId, id), isNull(erpEngineAssemblyBomLines.deletedAt)));

    const normalizedWithMeta = normalizedLines.map((line) => ({
      ...line,
      notes: serializeWarehouseBomLineMeta({
        text: line.notesText,
        lineKey: line.lineKey,
        parentLineKey: line.parentLineKey ?? null,
      }),
    }));

    if (normalizedWithMeta.length > 0) {
      await db.insert(erpEngineAssemblyBomLines).values(
        normalizedWithMeta.map((line) => ({
          id: line.id,
          bomId: line.bomId,
          componentNomenclatureId: line.componentNomenclatureId,
          componentType: line.componentType,
          qtyPerUnit: line.qtyPerUnit,
          variantGroup: line.variantGroup,
          isRequired: line.isRequired,
          priority: line.priority,
          notes: line.notes,
          createdAt: line.createdAt,
          updatedAt: line.updatedAt,
          deletedAt: line.deletedAt,
          syncStatus: line.syncStatus,
          lastServerSeq: line.lastServerSeq,
        })),
      );
    }

    // Синхронизируем junction-таблицу марок: софт-удаляем те, что больше не указаны, апсертим новые/обновлённые.
    const existingLinks = await db
      .select({
        id: erpEngineAssemblyBomBrandLinks.id,
        engineBrandId: erpEngineAssemblyBomBrandLinks.engineBrandId,
      })
      .from(erpEngineAssemblyBomBrandLinks)
      .where(and(eq(erpEngineAssemblyBomBrandLinks.bomId, id), isNull(erpEngineAssemblyBomBrandLinks.deletedAt)));
    const existingByBrand = new Map<string, string>();
    for (const link of existingLinks) {
      existingByBrand.set(String(link.engineBrandId), String(link.id));
    }
    const desiredSet = new Set(requestedBrandIds);
    const linksToInsert: Array<{
      id: string;
      bomId: string;
      engineBrandId: string;
      isPrimary: boolean;
      createdAt: number;
      updatedAt: number;
      deletedAt: number | null;
      syncStatus: 'synced';
      lastServerSeq: null;
    }> = [];
    const linksToUpdate: Array<{ id: string; engineBrandId: string; isPrimary: boolean }> = [];
    for (const [idx, brandId] of requestedBrandIds.entries()) {
      const isPrimary = idx === 0;
      const existingLinkId = existingByBrand.get(brandId);
      if (existingLinkId) {
        linksToUpdate.push({ id: existingLinkId, engineBrandId: brandId, isPrimary });
      } else {
        linksToInsert.push({
          id: randomUUID(),
          bomId: id,
          engineBrandId: brandId,
          isPrimary,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'synced',
          lastServerSeq: null,
        });
      }
    }
    const linksToDelete = existingLinks.filter((link) => !desiredSet.has(String(link.engineBrandId)));
    if (linksToInsert.length > 0) {
      await db.insert(erpEngineAssemblyBomBrandLinks).values(linksToInsert);
    }
    for (const update of linksToUpdate) {
      await db
        .update(erpEngineAssemblyBomBrandLinks)
        .set({ isPrimary: update.isPrimary, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(erpEngineAssemblyBomBrandLinks.id, update.id));
    }
    if (linksToDelete.length > 0) {
      await db
        .update(erpEngineAssemblyBomBrandLinks)
        .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
        .where(
          inArray(
            erpEngineAssemblyBomBrandLinks.id,
            linksToDelete.map((l) => String(l.id)) as any,
          ),
        );
    }

    const savedBom = await db.select().from(erpEngineAssemblyBom).where(eq(erpEngineAssemblyBom.id, id)).limit(1);
    if (savedBom[0]) {
      const row = savedBom[0];
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpEngineAssemblyBom,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            name: String(row.name),
            engine_nomenclature_id: row.engineNomenclatureId == null ? null : String(row.engineNomenclatureId),
            version: Number(row.version),
            status: String(row.status),
            is_default: Boolean(row.isDefault),
            notes: row.notes ?? null,
            created_at: Number(row.createdAt),
            updated_at: Number(row.updatedAt),
            deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
            sync_status: String(row.syncStatus ?? 'synced'),
            last_server_seq: row.lastServerSeq == null ? null : Number(row.lastServerSeq),
          },
          actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
          ts,
        },
      ]);
    }

    // Публикуем актуальное состояние junction-таблицы марок в ledger
    const allBrandLinks = await db
      .select()
      .from(erpEngineAssemblyBomBrandLinks)
      .where(eq(erpEngineAssemblyBomBrandLinks.bomId, id));
    if (allBrandLinks.length > 0) {
      const actorPayload = { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' };
      signAndAppendDetailed(
        allBrandLinks.map((link) => ({
          type: (link.deletedAt == null ? 'upsert' : 'delete') as 'upsert' | 'delete',
          table: LedgerTableName.ErpEngineAssemblyBomBrandLinks,
          row_id: String(link.id),
          row: {
            id: String(link.id),
            bom_id: String(link.bomId),
            engine_brand_id: String(link.engineBrandId),
            is_primary: Boolean(link.isPrimary),
            created_at: Number(link.createdAt),
            updated_at: Number(link.updatedAt),
            deleted_at: link.deletedAt == null ? null : Number(link.deletedAt),
            sync_status: String(link.syncStatus ?? 'synced'),
            last_server_seq: link.lastServerSeq == null ? null : Number(link.lastServerSeq),
          },
          actor: actorPayload,
          ts,
        })),
      );
    }

    const savedLines = await db
      .select()
      .from(erpEngineAssemblyBomLines)
      .where(and(eq(erpEngineAssemblyBomLines.bomId, id), isNull(erpEngineAssemblyBomLines.deletedAt)));
    if (savedLines.length > 0) {
      signAndAppendDetailed(
        savedLines.map((line) => ({
          type: 'upsert' as const,
          table: LedgerTableName.ErpEngineAssemblyBomLines,
          row_id: String(line.id),
          row: {
            id: String(line.id),
            bom_id: String(line.bomId),
            component_nomenclature_id: String(line.componentNomenclatureId),
            component_type: String(line.componentType),
            qty_per_unit: Number(line.qtyPerUnit),
            variant_group: line.variantGroup ?? null,
            is_required: Boolean(line.isRequired),
            priority: Number(line.priority),
            notes: line.notes ?? null,
            created_at: Number(line.createdAt),
            updated_at: Number(line.updatedAt),
            deleted_at: line.deletedAt == null ? null : Number(line.deletedAt),
            sync_status: String(line.syncStatus ?? 'synced'),
            last_server_seq: line.lastServerSeq == null ? null : Number(line.lastServerSeq),
          },
          actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
          ts,
        })),
      );
    }

    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteWarehouseAssemblyBom(args: { id: string; actor: Actor }): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id);
    const ts = nowMs();
    const headerRows = await db
      .select()
      .from(erpEngineAssemblyBom)
      .where(and(eq(erpEngineAssemblyBom.id, id), isNull(erpEngineAssemblyBom.deletedAt)))
      .limit(1);
    const headerRow = headerRows[0];
    if (!headerRow) return { ok: false, error: 'BOM не найден' };

    const linesBefore = await db
      .select()
      .from(erpEngineAssemblyBomLines)
      .where(and(eq(erpEngineAssemblyBomLines.bomId, id), isNull(erpEngineAssemblyBomLines.deletedAt)));
    const brandLinksBefore = await db
      .select()
      .from(erpEngineAssemblyBomBrandLinks)
      .where(and(eq(erpEngineAssemblyBomBrandLinks.bomId, id), isNull(erpEngineAssemblyBomBrandLinks.deletedAt)));

    await db
      .update(erpEngineAssemblyBomLines)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(erpEngineAssemblyBomLines.bomId, id), isNull(erpEngineAssemblyBomLines.deletedAt)));
    await db
      .update(erpEngineAssemblyBomBrandLinks)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(erpEngineAssemblyBomBrandLinks.bomId, id), isNull(erpEngineAssemblyBomBrandLinks.deletedAt)));
    await db
      .update(erpEngineAssemblyBom)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(erpEngineAssemblyBom.id, id));

    const actor = { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' };
    const lineDeletes = linesBefore.map((line) => ({
      type: 'delete' as const,
      table: LedgerTableName.ErpEngineAssemblyBomLines,
      row_id: String(line.id),
      row: {
        id: String(line.id),
        bom_id: String(line.bomId),
        component_nomenclature_id: String(line.componentNomenclatureId),
        component_type: String(line.componentType),
        qty_per_unit: Number(line.qtyPerUnit),
        variant_group: line.variantGroup ?? null,
        is_required: Boolean(line.isRequired),
        priority: Number(line.priority),
        notes: line.notes ?? null,
        created_at: Number(line.createdAt),
        updated_at: ts,
        deleted_at: ts,
        sync_status: String(line.syncStatus ?? 'synced'),
        last_server_seq: line.lastServerSeq == null ? null : Number(line.lastServerSeq),
      },
      actor,
      ts,
    }));
    const brandLinkDeletes = brandLinksBefore.map((link) => ({
      type: 'delete' as const,
      table: LedgerTableName.ErpEngineAssemblyBomBrandLinks,
      row_id: String(link.id),
      row: {
        id: String(link.id),
        bom_id: String(link.bomId),
        engine_brand_id: String(link.engineBrandId),
        is_primary: Boolean(link.isPrimary),
        created_at: Number(link.createdAt),
        updated_at: ts,
        deleted_at: ts,
        sync_status: String(link.syncStatus ?? 'synced'),
        last_server_seq: link.lastServerSeq == null ? null : Number(link.lastServerSeq),
      },
      actor,
      ts,
    }));
    signAndAppendDetailed([
      ...lineDeletes,
      ...brandLinkDeletes,
      {
        type: 'delete' as const,
        table: LedgerTableName.ErpEngineAssemblyBom,
        row_id: String(headerRow.id),
        row: {
          id: String(headerRow.id),
          name: String(headerRow.name),
          engine_nomenclature_id: headerRow.engineNomenclatureId == null ? null : String(headerRow.engineNomenclatureId),
          version: Number(headerRow.version),
          status: String(headerRow.status),
          is_default: Boolean(headerRow.isDefault),
          notes: headerRow.notes ?? null,
          created_at: Number(headerRow.createdAt),
          updated_at: ts,
          deleted_at: ts,
          sync_status: String(headerRow.syncStatus ?? 'synced'),
          last_server_seq: headerRow.lastServerSeq == null ? null : Number(headerRow.lastServerSeq),
        },
        actor,
        ts,
      },
    ]);

    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function activateWarehouseAssemblyBomAsDefault(args: {
  id: string;
  actor: Actor;
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id);
    const current = await db.select().from(erpEngineAssemblyBom).where(and(eq(erpEngineAssemblyBom.id, id), isNull(erpEngineAssemblyBom.deletedAt))).limit(1);
    const row = current[0];
    if (!row) return { ok: false, error: 'BOM не найден' };
    const ts = nowMs();
    await db
      .update(erpEngineAssemblyBom)
      .set({ status: 'active', isDefault: true, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(erpEngineAssemblyBom.id, id));
    const saved = await db.select().from(erpEngineAssemblyBom).where(eq(erpEngineAssemblyBom.id, id)).limit(1);
    const savedRow = saved[0];
    if (savedRow) {
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpEngineAssemblyBom,
          row_id: String(savedRow.id),
          row: {
            id: String(savedRow.id),
            name: String(savedRow.name),
            engine_nomenclature_id: savedRow.engineNomenclatureId == null ? null : String(savedRow.engineNomenclatureId),
            version: Number(savedRow.version),
            status: String(savedRow.status),
            is_default: Boolean(savedRow.isDefault),
            notes: savedRow.notes ?? null,
            created_at: Number(savedRow.createdAt),
            updated_at: Number(savedRow.updatedAt),
            deleted_at: savedRow.deletedAt == null ? null : Number(savedRow.deletedAt),
            sync_status: String(savedRow.syncStatus ?? 'synced'),
            last_server_seq: savedRow.lastServerSeq == null ? null : Number(savedRow.lastServerSeq),
          },
          actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
          ts,
        },
      ]);
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function archiveWarehouseAssemblyBom(args: { id: string; actor: Actor }): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id);
    const ts = nowMs();
    await db
      .update(erpEngineAssemblyBom)
      .set({ status: 'archived', isDefault: false, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(erpEngineAssemblyBom.id, id));
    const saved = await db.select().from(erpEngineAssemblyBom).where(eq(erpEngineAssemblyBom.id, id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpEngineAssemblyBom,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            name: String(row.name),
            engine_nomenclature_id: row.engineNomenclatureId == null ? null : String(row.engineNomenclatureId),
            version: Number(row.version),
            status: String(row.status),
            is_default: Boolean(row.isDefault),
            notes: row.notes ?? null,
            created_at: Number(row.createdAt),
            updated_at: Number(row.updatedAt),
            deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
            sync_status: String(row.syncStatus ?? 'synced'),
            last_server_seq: row.lastServerSeq == null ? null : Number(row.lastServerSeq),
          },
          actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
          ts,
        },
      ]);
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseAssemblyBomHistory(args: {
  engineBrandId: string;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  return listWarehouseAssemblyBoms({ engineBrandIds: [String(args.engineBrandId)] });
}

export async function getWarehouseAssemblyBomPrintPayload(args: {
  id: string;
}): Promise<Result<{ payload: { header: Record<string, unknown>; lines: Array<Record<string, unknown>> } }>> {
  try {
    const details = await loadBomDetailsById(String(args.id));
    if (!details.ok) return details as any;
    return { ok: true, payload: details.bom };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getWarehouseAssemblyBomComponentTypeUsage(): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const rows = await db
      .select({
        componentType: erpEngineAssemblyBomLines.componentType,
        status: erpEngineAssemblyBom.status,
      })
      .from(erpEngineAssemblyBomLines)
      .innerJoin(erpEngineAssemblyBom, eq(erpEngineAssemblyBom.id, erpEngineAssemblyBomLines.bomId))
      .where(and(isNull(erpEngineAssemblyBomLines.deletedAt), isNull(erpEngineAssemblyBom.deletedAt)));
    const usage = new Map<string, { total: number; active: number; draft: number; archived: number }>();
    for (const row of rows) {
      const typeId = String(row.componentType ?? '').trim().toLowerCase();
      if (!typeId) continue;
      const status = String(row.status ?? 'draft').trim().toLowerCase();
      const current = usage.get(typeId) ?? { total: 0, active: 0, draft: 0, archived: 0 };
      current.total += 1;
      if (status === 'active') current.active += 1;
      else if (status === 'archived') current.archived += 1;
      else current.draft += 1;
      usage.set(typeId, current);
    }
    const resultRows = Array.from(usage.entries())
      .map(([typeId, count]) => ({
        typeId,
        totalLineCount: count.total,
        activeLineCount: count.active,
        draftLineCount: count.draft,
        archivedLineCount: count.archived,
      }))
      .sort((a, b) => String(a.typeId).localeCompare(String(b.typeId), 'ru'));
    return { ok: true, rows: resultRows };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function renameWarehouseBomComponentTypes(args: {
  renames: Array<{ fromTypeId: string; toTypeId: string }>;
  actor: Actor;
}): Promise<Result<{ renamedLineCount: number }>> {
  try {
    const normalized = Array.from(
      new Map(
        (Array.isArray(args.renames) ? args.renames : [])
          .map((row) => ({
            fromTypeId: String(row.fromTypeId ?? '').trim().toLowerCase(),
            toTypeId: String(row.toTypeId ?? '').trim().toLowerCase(),
          }))
          .filter((row) => row.fromTypeId && row.toTypeId && row.fromTypeId !== row.toTypeId)
          .map((row) => [`${row.fromTypeId}=>${row.toTypeId}`, row]),
      ).values(),
    );
    if (normalized.length === 0) return { ok: true, renamedLineCount: 0 };

    let renamedLineCount = 0;
    for (const rename of normalized) {
      const rows = await db
        .select()
        .from(erpEngineAssemblyBomLines)
        .where(and(eq(erpEngineAssemblyBomLines.componentType, rename.fromTypeId), isNull(erpEngineAssemblyBomLines.deletedAt)));
      if (rows.length === 0) continue;
      const ts = nowMs();
      const ids = rows.map((row) => String(row.id));
      await db
        .update(erpEngineAssemblyBomLines)
        .set({
          componentType: rename.toTypeId,
          updatedAt: ts,
          syncStatus: 'synced',
        })
        .where(inArray(erpEngineAssemblyBomLines.id, ids as any));
      const updatedRows = await db.select().from(erpEngineAssemblyBomLines).where(inArray(erpEngineAssemblyBomLines.id, ids as any));
      renamedLineCount += updatedRows.length;
      signAndAppendDetailed(
        updatedRows.map((line) => ({
          type: 'upsert' as const,
          table: LedgerTableName.ErpEngineAssemblyBomLines,
          row_id: String(line.id),
          row: {
            id: String(line.id),
            bom_id: String(line.bomId),
            component_nomenclature_id: String(line.componentNomenclatureId),
            component_type: String(line.componentType),
            qty_per_unit: Number(line.qtyPerUnit),
            variant_group: line.variantGroup ?? null,
            is_required: Boolean(line.isRequired),
            priority: Number(line.priority),
            notes: line.notes ?? null,
            created_at: Number(line.createdAt),
            updated_at: Number(line.updatedAt),
            deleted_at: line.deletedAt == null ? null : Number(line.deletedAt),
            sync_status: String(line.syncStatus ?? 'synced'),
            last_server_seq: line.lastServerSeq == null ? null : Number(line.lastServerSeq),
          },
          actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
          ts,
        })),
      );
    }

    return { ok: true, renamedLineCount };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function buildWarehouseBomExpandedForecast(args: {
  engineBrandId: string;
  targetEnginesPerDay?: number;
  horizonDays?: number;
  warehouseIds?: string[];
}): Promise<Result<{ rows: Array<Record<string, unknown>>; warnings: string[] }>> {
  try {
    const brandId = String(args.engineBrandId).trim();
    if (!brandId) return { ok: false, error: 'engineBrandId обязателен' };
    const horizonDays = Math.max(1, Math.min(31, Math.trunc(Number(args.horizonDays ?? 7))));
    const target = Math.max(0, Math.trunc(Number(args.targetEnginesPerDay ?? 4)));
    const totalEngines = target * horizonDays;
    const warehouseSet = Array.isArray(args.warehouseIds) && args.warehouseIds.length > 0 ? new Set(args.warehouseIds.map(String)) : null;

    // Ищем активную BOM для марки через junction. Если на марку привязано несколько BOM, берём с isDefault=true, иначе самую свежую.
    const bomRows = await db
      .select({
        id: erpEngineAssemblyBom.id,
        isDefault: erpEngineAssemblyBom.isDefault,
        updatedAt: erpEngineAssemblyBom.updatedAt,
      })
      .from(erpEngineAssemblyBom)
      .innerJoin(
        erpEngineAssemblyBomBrandLinks,
        and(
          eq(erpEngineAssemblyBomBrandLinks.bomId, erpEngineAssemblyBom.id),
          isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
        ),
      )
      .where(
        and(
          eq(erpEngineAssemblyBomBrandLinks.engineBrandId, brandId),
          eq(erpEngineAssemblyBom.status, 'active'),
          isNull(erpEngineAssemblyBom.deletedAt),
        ),
      )
      .orderBy(desc(erpEngineAssemblyBom.isDefault), desc(erpEngineAssemblyBom.updatedAt))
      .limit(1);
    const bom = bomRows[0];
    if (!bom) return { ok: false, error: 'Нет активной BOM для выбранной марки двигателя' };

    const lineRows = await db
      .select({
        componentNomenclatureId: erpEngineAssemblyBomLines.componentNomenclatureId,
        componentType: erpEngineAssemblyBomLines.componentType,
        qtyPerUnit: erpEngineAssemblyBomLines.qtyPerUnit,
        variantGroup: erpEngineAssemblyBomLines.variantGroup,
        notes: erpEngineAssemblyBomLines.notes,
        isRequired: erpEngineAssemblyBomLines.isRequired,
        priority: erpEngineAssemblyBomLines.priority,
        code: erpNomenclature.code,
        name: erpNomenclature.name,
      })
      .from(erpEngineAssemblyBomLines)
      .leftJoin(erpNomenclature, eq(erpNomenclature.id, erpEngineAssemblyBomLines.componentNomenclatureId))
      .where(and(eq(erpEngineAssemblyBomLines.bomId, bom.id), isNull(erpEngineAssemblyBomLines.deletedAt)))
      .orderBy(asc(erpEngineAssemblyBomLines.priority), asc(erpEngineAssemblyBomLines.createdAt));

    const stockRows = await db.select().from(erpRegStockBalance);
    const stockMap = new Map<string, number>();
    for (const row of stockRows) {
      const nomenclatureId = row.nomenclatureId ? String(row.nomenclatureId) : '';
      if (!nomenclatureId) continue;
      if (warehouseSet && !warehouseSet.has(String(row.warehouseId))) continue;
      const available = Math.max(0, Number(row.qty ?? 0) - Number(row.reservedQty ?? 0));
      stockMap.set(nomenclatureId, (stockMap.get(nomenclatureId) ?? 0) + available);
    }

    const now = nowMs();
    const to = now + horizonDays * 24 * 60 * 60 * 1000;
    const incomingRows = await db
      .select()
      .from(erpPlannedIncoming)
      .where(and(isNull(erpPlannedIncoming.deletedAt), sql`${erpPlannedIncoming.expectedDate} >= ${now}`, sql`${erpPlannedIncoming.expectedDate} <= ${to}`));
    const incomingMap = new Map<string, number>();
    for (const row of incomingRows) {
      const nomenclatureId = String(row.nomenclatureId);
      if (!nomenclatureId) continue;
      if (warehouseSet && !warehouseSet.has(String(row.warehouseId))) continue;
      const qty = Math.max(0, Number(row.qty ?? 0));
      if (qty <= 0) continue;
      incomingMap.set(nomenclatureId, (incomingMap.get(nomenclatureId) ?? 0) + qty);
    }

    const rows = lineRows.map((line) => {
      const nomenclatureId = String(line.componentNomenclatureId);
      const meta = parseWarehouseBomLineMeta((line as { notes?: string | null }).notes ?? null);
      const requiredQty = Math.max(0, Number(line.qtyPerUnit ?? 0)) * totalEngines;
      const stockQty = stockMap.get(nomenclatureId) ?? 0;
      const plannedIncomingQty = incomingMap.get(nomenclatureId) ?? 0;
      const deficitQty = Math.max(0, requiredQty - stockQty - plannedIncomingQty);
      return {
        componentNomenclatureId: nomenclatureId,
        componentNomenclatureCode: line.code ? String(line.code) : null,
        componentNomenclatureName: line.name ? String(line.name) : null,
        componentType: String(line.componentType),
        qtyPerUnit: Number(line.qtyPerUnit ?? 0),
        requiredQty,
        stockQty,
        plannedIncomingQty,
        deficitQty,
        variantGroup: line.variantGroup ?? null,
        lineKey: meta.lineKey,
        parentLineKey: meta.parentLineKey,
        isRequired: Boolean(line.isRequired),
        priority: Number(line.priority ?? 100),
      };
    });

    const lineKeySet = new Set(rows.map((row) => String(row.lineKey ?? '').trim()).filter(Boolean));
    const droppedDependentCount = rows.filter((row) => row.parentLineKey && !lineKeySet.has(String(row.parentLineKey))).length;
    const filteredRows = rows.filter((row) => !row.parentLineKey || lineKeySet.has(String(row.parentLineKey)));
    const warnings = droppedDependentCount > 0 ? [`Пропущено строк BOM без родительского узла: ${droppedDependentCount}`] : [];

    return { ok: true, rows: filteredRows, warnings };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Пересчитывает priority всех активных строк BOM по sortOrder из текущей глобальной схемы.
 * Вызывается после сохранения изменений в схеме, чтобы строки перестраивались по новому порядку.
 */
export async function reorderAllBomLinesBySchema(): Promise<Result<{ updatedCount: number }>> {
  try {
    const schema = await loadSanitizedBomRelationSchema();
    const sortOrderMap = buildSchemaSortOrderMap(schema);

    const distinctTypes = Array.from(sortOrderMap.entries());
    let updatedCount = 0;
    const ts = nowMs();

    for (const [typeId, priority] of distinctTypes) {
      const result = await db
        .update(erpEngineAssemblyBomLines)
        .set({ priority, updatedAt: ts, syncStatus: 'synced' })
        .where(
          and(
            isNull(erpEngineAssemblyBomLines.deletedAt),
            eq(erpEngineAssemblyBomLines.componentType, typeId),
          ),
        );
      updatedCount += (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
    }

    // Типы не в схеме → priority = 100 (fallback)
    const knownTypeIds = Array.from(sortOrderMap.keys());
    if (knownTypeIds.length > 0) {
      await db
        .update(erpEngineAssemblyBomLines)
        .set({ priority: 100, updatedAt: ts, syncStatus: 'synced' })
        .where(
          and(
            isNull(erpEngineAssemblyBomLines.deletedAt),
            sql`${erpEngineAssemblyBomLines.componentType} NOT IN (${sql.join(knownTypeIds.map((t) => sql`${t}`), sql`, `)})`,
          ),
        );
    }

    return { ok: true, updatedCount };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

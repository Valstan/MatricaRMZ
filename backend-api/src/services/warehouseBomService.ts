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

function normalizeComponentType(raw: string | undefined): 'sleeve' | 'piston' | 'ring' | 'jacket' | 'head' | 'other' {
  const value = String(raw ?? 'other').trim().toLowerCase();
  if (value === 'sleeve' || value === 'piston' || value === 'ring' || value === 'jacket' || value === 'head') return value;
  return 'other';
}

const KNOWN_COMPONENT_TYPES = new Set(['sleeve', 'piston', 'ring', 'jacket', 'head', 'other']);

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

/** Любая номенклатура «двигатель» для марки — только для технической заглушки в черновых строках BOM (FK), не смысловая привязка спецификации. */
async function pickStubNomenclatureIdForBrand(engineBrandId: string): Promise<string | null> {
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

export async function listWarehouseAssemblyBoms(args?: {
  engineBrandId?: string;
  /** Совместимость: фильтр по старой колонке, если ещё заполнена. */
  engineNomenclatureId?: string;
  status?: string;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const conditions = [isNull(erpEngineAssemblyBom.deletedAt)];
    if (args?.engineBrandId) {
      conditions.push(eq(erpEngineAssemblyBom.engineBrandId, String(args.engineBrandId)));
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
        engineBrandId: erpEngineAssemblyBom.engineBrandId,
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

    const visibleRows = (() => {
      const perBrand = new Map<string, (typeof headerRows)[number]>();
      for (const row of headerRows) {
        const brandId = String(row.engineBrandId);
        if (!brandId) continue;
        if (!perBrand.has(brandId)) perBrand.set(brandId, row);
      }
      return Array.from(perBrand.values());
    })();
    return {
      ok: true,
      rows: visibleRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        engineBrandId: String(row.engineBrandId),
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
      engineBrandId: erpEngineAssemblyBom.engineBrandId,
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
  const header: Record<string, unknown> = {
    id: String(hr.id),
    name: String(hr.name),
    engineBrandId: String(hr.engineBrandId),
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
  engineBrandId: string;
  /** Явная номенклатура «двигатель»; иначе подставляется stub по марке. */
  engineNomenclatureId?: string | null;
  version?: number;
  status?: string;
  isDefault?: boolean;
  notes?: string | null;
  lines: BomLineInput[];
  actor: Actor;
}): Promise<Result<{ id: string }>> {
  try {
    const requestedBrandId = String(args.engineBrandId).trim();
    if (!requestedBrandId) return { ok: false, error: 'Марка двигателя (engineBrandId) обязательна' };

    const existingForBrand = await db
      .select({ id: erpEngineAssemblyBom.id })
      .from(erpEngineAssemblyBom)
      .where(and(eq(erpEngineAssemblyBom.engineBrandId, requestedBrandId), isNull(erpEngineAssemblyBom.deletedAt)))
      .orderBy(desc(erpEngineAssemblyBom.updatedAt), desc(erpEngineAssemblyBom.version))
      .limit(1);
    const existingId = existingForBrand[0]?.id ? String(existingForBrand[0].id) : null;
    const id = String(args.id ?? existingId ?? randomUUID());
    if (args.id) {
      const otherForBrand = await db
        .select({ id: erpEngineAssemblyBom.id })
        .from(erpEngineAssemblyBom)
        .where(
          and(
            eq(erpEngineAssemblyBom.engineBrandId, requestedBrandId),
            isNull(erpEngineAssemblyBom.deletedAt),
            sql`${erpEngineAssemblyBom.id} <> ${id}`,
          ),
        )
        .limit(1);
      if (otherForBrand[0]?.id) {
        return {
          ok: false,
          error:
            'Для выбранной марки двигателя уже есть другая спецификация. Удалите или откройте ту карточку, либо выберите другую марку.',
        };
      }
    }
    const ts = nowMs();
    const status = 'active';
    const version = Math.max(1, Math.trunc(Number(args.version ?? 1)));
    const stubId = await pickStubNomenclatureIdForBrand(requestedBrandId);
    if (!stubId) {
      return {
        ok: false,
        error:
          'Для выбранной марки нет номенклатуры типа «двигатель». Создайте позицию с типом/категорией engine и привязкой к этой марке (поле «марка по умолчанию» или связь в справочнике), затем повторите сохранение BOM.',
      };
    }
    const explicitNom = args.engineNomenclatureId != null && String(args.engineNomenclatureId).trim() ? String(args.engineNomenclatureId).trim() : null;
    const base = {
      name: String(args.name ?? '').trim() || `BOM ${version}`,
      engineBrandId: requestedBrandId,
      engineNomenclatureId: explicitNom ?? stubId,
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
        stubComponentNomenclatureId: stubId,
        schema: sanitizedSchema,
        variantGroupId,
        lineKeyPrefix,
      });
    }

    const normalizedLines = sourceLines
      .map((line) => ({
        id: randomUUID(),
        bomId: id,
        componentNomenclatureId: String(line.componentNomenclatureId),
        componentType: normalizeComponentType(line.componentType),
        qtyPerUnit: Math.max(0, Math.trunc(Number(line.qtyPerUnit ?? 0))),
        variantGroup: line.variantGroup == null ? null : String(line.variantGroup).trim() || null,
        lineKey: normalizeBomRelationKey(line.lineKey == null ? null : String(line.lineKey)),
        parentLineKey: normalizeBomRelationKey(line.parentLineKey == null ? null : String(line.parentLineKey)),
        isRequired: line.isRequired !== false,
        priority: Math.max(0, Math.trunc(Number(line.priority ?? 100))),
        notesText: line.notes == null ? null : String(line.notes),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced' as const,
        lastServerSeq: null,
      }))
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

    await db
      .update(erpEngineAssemblyBom)
      .set({ isDefault: false, updatedAt: ts, syncStatus: 'synced' })
      .where(
        and(
          eq(erpEngineAssemblyBom.engineBrandId, requestedBrandId),
          isNull(erpEngineAssemblyBom.deletedAt),
          eq(erpEngineAssemblyBom.status, 'active'),
          sql`${erpEngineAssemblyBom.id} <> ${id}`,
        ),
      );

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
            engine_brand_id: String(row.engineBrandId),
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

    await db
      .update(erpEngineAssemblyBomLines)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(erpEngineAssemblyBomLines.bomId, id), isNull(erpEngineAssemblyBomLines.deletedAt)));
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
    signAndAppendDetailed([
      ...lineDeletes,
      {
        type: 'delete' as const,
        table: LedgerTableName.ErpEngineAssemblyBom,
        row_id: String(headerRow.id),
        row: {
          id: String(headerRow.id),
          name: String(headerRow.name),
          engine_brand_id: String(headerRow.engineBrandId),
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
      .set({ isDefault: false, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(erpEngineAssemblyBom.engineBrandId, row.engineBrandId), isNull(erpEngineAssemblyBom.deletedAt)));
    await db
      .update(erpEngineAssemblyBom)
      .set({ status: 'active', isDefault: true, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(erpEngineAssemblyBom.id, id));
    const affected = await db
      .select()
      .from(erpEngineAssemblyBom)
      .where(and(eq(erpEngineAssemblyBom.engineBrandId, row.engineBrandId), isNull(erpEngineAssemblyBom.deletedAt)));
    if (affected.length > 0) {
      signAndAppendDetailed(
        affected.map((item) => ({
          type: 'upsert' as const,
          table: LedgerTableName.ErpEngineAssemblyBom,
          row_id: String(item.id),
          row: {
            id: String(item.id),
            name: String(item.name),
            engine_brand_id: String(item.engineBrandId),
            engine_nomenclature_id: item.engineNomenclatureId == null ? null : String(item.engineNomenclatureId),
            version: Number(item.version),
            status: String(item.status),
            is_default: Boolean(item.isDefault),
            notes: item.notes ?? null,
            created_at: Number(item.createdAt),
            updated_at: Number(item.updatedAt),
            deleted_at: item.deletedAt == null ? null : Number(item.deletedAt),
            sync_status: String(item.syncStatus ?? 'synced'),
            last_server_seq: item.lastServerSeq == null ? null : Number(item.lastServerSeq),
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
            engine_brand_id: String(row.engineBrandId),
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
  return listWarehouseAssemblyBoms({ engineBrandId: String(args.engineBrandId) });
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
    const target = Math.max(0, Math.trunc(Number(args.targetEnginesPerDay ?? 1)));
    const totalEngines = target * horizonDays;
    const warehouseSet = Array.isArray(args.warehouseIds) && args.warehouseIds.length > 0 ? new Set(args.warehouseIds.map(String)) : null;

    const bomRows = await db
      .select()
      .from(erpEngineAssemblyBom)
      .where(
        and(
          eq(erpEngineAssemblyBom.engineBrandId, brandId),
          eq(erpEngineAssemblyBom.status, 'active'),
          eq(erpEngineAssemblyBom.isDefault, true),
          isNull(erpEngineAssemblyBom.deletedAt),
        ),
      )
      .orderBy(desc(erpEngineAssemblyBom.updatedAt))
      .limit(1);
    const bom = bomRows[0];
    if (!bom) return { ok: false, error: 'Нет активной default BOM для выбранной марки двигателя' };

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

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';
import {
  normalizeBomRelationKey,
  resolveNomenclatureComponentTypeId,
  type AssemblyExecutionProfile,
} from '@matricarmz/shared';

import type { AuthUser } from '../auth/jwt.js';
import { db } from '../database/db.js';
import {
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpPlannedIncoming,
  erpRegStockBalance,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';
import { ensureNomenclatureBrandPart } from './bomBrandPartSync.js';
import { normalizeNormPercent, parseWarehouseBomLineMeta, serializeWarehouseBomLineMeta } from './warehouseBomLineMeta.js';

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

function parseExecutionProfile(raw: string | null): AssemblyExecutionProfile | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as AssemblyExecutionProfile)
      : null;
  } catch {
    return null;
  }
}

/**
 * Нормализация componentType: trim+lowercase, пустые → 'other'.
 * Раньше тут был жёсткий whitelist из 7 типов (sleeve/piston/ring/jacket/head/carter/other),
 * и любой кастомный typeId из глобальной схемы (например, 'block' после переименования)
 * молча превращался в 'other'. Это приводило к потере данных: при сохранении BOM
 * componentType=<custom> переписывался на 'other', при reload клиент не находил нужный тип
 * среди строк, добавлял черновую — и пользовательский выбор «исчезал».
 * Теперь любая непустая строка-typeId пропускается как есть; целостность обеспечивает
 * глобальная схема + UI-валидация.
 */
function normalizeComponentType(raw: string | undefined): string {
  const value = String(raw ?? '').trim().toLowerCase();
  return value || 'other';
}

function variantScopeKey(v: string | null | undefined): string {
  const s = String(v ?? '').trim();
  return s.length > 0 ? s : '__base__';
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
  return byDefault[0]?.id ? String(byDefault[0].id) : null;
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
  /** Норма расхода, % (G8). undefined = не прислано клиентом (наследуем от существующей строки), null = явно очистить. */
  normPercent?: number | null;
  positionKey?: string | null;
  positionLabel?: string | null;
  isDefaultOption?: boolean;
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

async function loadDefaultBrandIdsForBoms(bomIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (bomIds.length === 0) return result;
  const links = await db
    .select({
      bomId: erpEngineAssemblyBomBrandLinks.bomId,
      engineBrandId: erpEngineAssemblyBomBrandLinks.engineBrandId,
    })
    .from(erpEngineAssemblyBomBrandLinks)
    .where(
      and(
        inArray(erpEngineAssemblyBomBrandLinks.bomId, bomIds as any),
        eq(erpEngineAssemblyBomBrandLinks.isDefaultForBrand, true),
        isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
      ),
    );
  for (const link of links) {
    const key = String(link.bomId);
    result.set(key, [...(result.get(key) ?? []), String(link.engineBrandId)]);
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
        defaultVariantKey: erpEngineAssemblyBom.defaultVariantKey,
        executionProfileJson: erpEngineAssemblyBom.executionProfileJson,
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
    // Количество вариантов сборки = количество уникальных scope'ов (base + __kit_*) в строках BOM.
    // Пустой BOM = 0, классическая (без variant'ов) = 1, BOM с двумя kit'ами без base = 2 и т.д.
    const variantsCounts = new Map<string, number>();
    if (bomIds.length > 0) {
      const grouped = await db
        .select({
          bomId: erpEngineAssemblyBomLines.bomId,
          count: sql<number>`count(distinct coalesce(${erpEngineAssemblyBomLines.variantGroup}, '__base__'))`,
        })
        .from(erpEngineAssemblyBomLines)
        .where(and(inArray(erpEngineAssemblyBomLines.bomId, bomIds as any), isNull(erpEngineAssemblyBomLines.deletedAt)))
        .groupBy(erpEngineAssemblyBomLines.bomId);
      for (const row of grouped) {
        variantsCounts.set(String(row.bomId), Number(row.count ?? 0));
      }
    }
    const brandIdsMap = await loadBrandIdsForBoms(bomIds);
    const defaultBrandIdsMap = await loadDefaultBrandIdsForBoms(bomIds);

    return {
      ok: true,
      rows: headerRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        engineBrandIds: brandIdsMap.get(String(row.id)) ?? [],
        defaultForBrandIds: defaultBrandIdsMap.get(String(row.id)) ?? [],
        engineNomenclatureId: row.engineNomenclatureId ? String(row.engineNomenclatureId) : null,
        engineNomenclatureCode: row.engineCode ? String(row.engineCode) : null,
        engineNomenclatureName: row.engineName ? String(row.engineName) : null,
        version: Number(row.version ?? 1),
        status: String(row.status),
        isDefault: Boolean(row.isDefault),
        defaultVariantKey: row.defaultVariantKey ?? null,
        executionProfile: parseExecutionProfile(row.executionProfileJson),
        notes: row.notes ?? null,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
        variantsCount: variantsCounts.get(String(row.id)) ?? 0,
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
      defaultVariantKey: erpEngineAssemblyBom.defaultVariantKey,
      executionProfileJson: erpEngineAssemblyBom.executionProfileJson,
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
  const defaultBrandIdsMap = await loadDefaultBrandIdsForBoms([bomId]);
  const header: Record<string, unknown> = {
    id: String(hr.id),
    name: String(hr.name),
    engineBrandIds: brandIdsMap.get(bomId) ?? [],
    defaultForBrandIds: defaultBrandIdsMap.get(bomId) ?? [],
    engineNomenclatureId: hr.engineNomenclatureId ? String(hr.engineNomenclatureId) : null,
    engineNomenclatureCode: hr.engineCode ? String(hr.engineCode) : null,
    engineNomenclatureName: hr.engineName ? String(hr.engineName) : null,
    version: Number(hr.version ?? 1),
    status: String(hr.status),
    isDefault: Boolean(hr.isDefault),
    defaultVariantKey: hr.defaultVariantKey ?? null,
    executionProfile: parseExecutionProfile(hr.executionProfileJson),
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
      componentNomenclatureCategory: erpNomenclature.category,
      componentNomenclatureItemType: erpNomenclature.itemType,
      componentNomenclatureSpecJson: erpNomenclature.specJson,
      componentNomenclatureComponentTypeId: erpNomenclature.componentTypeId,
      componentType: erpEngineAssemblyBomLines.componentType,
      qtyPerUnit: erpEngineAssemblyBomLines.qtyPerUnit,
      variantGroup: erpEngineAssemblyBomLines.variantGroup,
      isRequired: erpEngineAssemblyBomLines.isRequired,
      priority: erpEngineAssemblyBomLines.priority,
      notes: erpEngineAssemblyBomLines.notes,
      positionKey: erpEngineAssemblyBomLines.positionKey,
      positionLabel: erpEngineAssemblyBomLines.positionLabel,
      isDefaultOption: erpEngineAssemblyBomLines.isDefaultOption,
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

  // Для UI-диагностики рассинхрона: маппинг nomenclatureId → ожидаемый componentTypeId
  // (по карточке номенклатуры: specJson.componentTypeId либо эвристика). UI сравнивает с
  // фактическим componentType строки и подсвечивает рассогласования (v1.21.3).
  const componentTypeByNomenclatureId: Record<string, string | null> = {};
  const seenNomenclatureIds = new Set<string>();
  for (const row of lines) {
    const nomId = String(row.componentNomenclatureId);
    if (seenNomenclatureIds.has(nomId)) continue;
    seenNomenclatureIds.add(nomId);
    componentTypeByNomenclatureId[nomId] = resolveNomenclatureComponentTypeId({
      name: row.componentNomenclatureName ?? null,
      code: row.componentNomenclatureCode ?? null,
      category: row.componentNomenclatureCategory ?? null,
      itemType: row.componentNomenclatureItemType ?? null,
      specJson: row.componentNomenclatureSpecJson ?? null,
      componentTypeId: row.componentNomenclatureComponentTypeId ?? null,
    });
  }
  header.componentTypeByNomenclatureId = componentTypeByNomenclatureId;

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
        normPercent: parsedLineMeta.get(String(row.id))?.normPercent ?? null,
        positionKey: row.positionKey ?? null,
        positionLabel: row.positionLabel ?? null,
        isDefaultOption: Boolean(row.isDefaultOption ?? true),
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
  defaultForBrandIds?: string[];
  /** Опционально: legacy-колонка — номенклатура типа engine для марки; иначе null. Черновые строки используют отдельный resolve. */
  engineNomenclatureId?: string | null;
  version?: number;
  status?: string;
  isDefault?: boolean;
  defaultVariantKey?: string | null;
  executionProfile?: AssemblyExecutionProfile | null;
  notes?: string | null;
  lines: BomLineInput[];
  actor: Actor;
}): Promise<Result<{ id: string; warnings?: string[] }>> {
  try {
    const requestedBrandIds = Array.from(
      new Set(
        (Array.isArray(args.engineBrandIds) ? args.engineBrandIds : [])
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
    const requestedDefaultBrandIds = args.defaultForBrandIds === undefined
      ? null
      : new Set(args.defaultForBrandIds.map(String).map((value) => value.trim()).filter(Boolean));
    if (requestedDefaultBrandIds && [...requestedDefaultBrandIds].some((brandId) => !requestedBrandIds.includes(brandId))) {
      return { ok: false, error: 'defaultForBrandIds должен быть подмножеством engineBrandIds' };
    }
    if (requestedBrandIds.length === 0) {
      return { ok: false, error: 'Не указана ни одна марка двигателя (engineBrandIds)' };
    }
    const primaryBrandId = requestedBrandIds[0]!;
    const id = String(args.id ?? randomUUID());

    const ts = nowMs();
    const status = 'active';
    const version = Math.max(1, Math.trunc(Number(args.version ?? 1)));
    const explicitNom = args.engineNomenclatureId != null && String(args.engineNomenclatureId).trim() ? String(args.engineNomenclatureId).trim() : null;
    const headerEngineNom = explicitNom ?? (await pickEngineNomenclatureIdForBrand(primaryBrandId));
    const base = {
      name: String(args.name ?? '').trim() || `BOM ${version}`,
      engineNomenclatureId: headerEngineNom,
      version,
      status,
      isDefault: true,
      defaultVariantKey: args.defaultVariantKey == null ? null : String(args.defaultVariantKey).trim() || null,
      executionProfileJson: args.executionProfile ? JSON.stringify(args.executionProfile) : null,
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

    // Пустой BOM — валидное состояние. Backend больше не fabricует skeleton-строки
    // (v1.21.3): если клиент прислал пустой список — сохраняем BOM без строк.
    // Skeleton с пустыми компонентами создаётся явным действием пользователя в UI.
    const sourceLines = Array.isArray(args.lines) ? args.lines : [];

    const initialNormalizedLines = sourceLines
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
        priority: Math.max(0, Math.trunc(Number(line.priority ?? 100))),
        notesText: line.notes == null ? null : String(line.notes),
        normPercentInput: line.normPercent === undefined ? undefined : normalizeNormPercent(line.normPercent),
        positionKey: line.positionKey == null ? null : String(line.positionKey).trim() || null,
        positionLabel: line.positionLabel == null ? null : String(line.positionLabel).trim() || null,
        isDefaultOption: line.isDefaultOption !== false,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced' as const,
        lastServerSeq: null,
        };
      })
      .filter((line) => line.componentNomenclatureId);

    // Auto-fix componentType ↔ nomenclature.componentTypeId (v1.21.3).
    // Карточка номенклатуры — единственный источник истины для типа компонента BOM.
    // Если componentType строки не совпадает с derive'нутым типом из её номенклатуры
    // (specJson.componentTypeId либо эвристика по name/code), backend переписывает
    // componentType на значение из номенклатуры и кладёт сообщение в warnings.
    // Если у номенклатуры тип не определён (resolve вернул null) — warning без auto-fix,
    // строка сохраняется как есть. Это даёт миграционный путь: пользователь видит,
    // в каких номенклатурах нужно заполнить «Тип компонента BOM».
    const warnings: string[] = [];
    const uniqueNomenclatureIds = Array.from(
      new Set(initialNormalizedLines.map((line) => line.componentNomenclatureId).filter(Boolean)),
    );
    const nomenclatureById = new Map<
      string,
      {
        id: string;
        name: string | null;
        code: string | null;
        category: string | null;
        itemType: string | null;
        specJson: string | null;
        componentTypeId: string | null;
      }
    >();
    if (uniqueNomenclatureIds.length > 0) {
      const rows = await db
        .select({
          id: erpNomenclature.id,
          name: erpNomenclature.name,
          code: erpNomenclature.code,
          category: erpNomenclature.category,
          itemType: erpNomenclature.itemType,
          specJson: erpNomenclature.specJson,
          componentTypeId: erpNomenclature.componentTypeId,
        })
        .from(erpNomenclature)
        .where(inArray(erpNomenclature.id, uniqueNomenclatureIds as any));
      for (const row of rows) {
        nomenclatureById.set(String(row.id), {
          id: String(row.id),
          name: row.name ?? null,
          code: row.code ?? null,
          category: row.category ?? null,
          itemType: row.itemType ?? null,
          specJson: row.specJson ?? null,
          componentTypeId: row.componentTypeId ?? null,
        });
      }
    }
    const warnedMissingTypeForNomenclature = new Set<string>();
    const normalizedLines = initialNormalizedLines.map((line) => {
      const nomRow = nomenclatureById.get(line.componentNomenclatureId);
      if (!nomRow) return line; // FK сработает позже и вернёт ошибку DB.
      const expected = resolveNomenclatureComponentTypeId(nomRow);
      const nomLabel = nomRow.name || nomRow.code || line.componentNomenclatureId;
      if (expected === null) {
        if (!warnedMissingTypeForNomenclature.has(line.componentNomenclatureId)) {
          warnedMissingTypeForNomenclature.add(line.componentNomenclatureId);
          warnings.push(
            `Номенклатура «${nomLabel}»: не задан «Тип компонента BOM». Откройте карточку номенклатуры и заполните поле, чтобы строка BOM сохранялась с правильным типом.`,
          );
        }
        return line;
      }
      if (line.componentType === expected) return line;
      warnings.push(
        `Строка «${nomLabel}»: тип «${line.componentType}» приведён к «${expected}» (по карточке номенклатуры).`,
      );
      return {
        ...line,
        componentType: expected,
      };
    });

    // Глобальная схема БОЛЬШЕ НЕ обязательна (план engine-spec-position-variants-2026-07):
    // у разных марок наборы деталей отличаются (2 картера / плита / блок), поэтому проверка
    // «в BOM присутствуют все обязательные типы схемы» снята. BOM может содержать любой набор.
    // Схема остаётся необязательным шаблоном-подсказкой на стороне UI, а не жёстким валидатором.
    const linesByVariantScope = new Map<string, typeof normalizedLines>();
    for (const line of normalizedLines) {
      const sk = variantScopeKey(line.variantGroup);
      const arr = linesByVariantScope.get(sk) ?? [];
      arr.push(line);
      linesByVariantScope.set(sk, arr);
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

    // Pre-check дублей строк по уникальному ключу `(variantGroup, componentNomenclatureId, componentType)`.
    // Превращает молчаливую потерю в чёткую ошибку — DB UNIQUE index 0043 иначе отверг бы INSERT
    // без понятного фидбека пользователю. Auto-merge не делается намеренно: тихое слияние
    // строк скрывало бы человеческую ошибку при заполнении BOM.
    const duplicateKeyCounts = new Map<string, number>();
    const duplicateKeyExample = new Map<string, { variantGroup: string | null; componentType: string; componentNomenclatureId: string }>();
    for (const line of normalizedLines) {
      const dedupKey = `${line.variantGroup ?? '__base__'}::${line.componentType}::${line.componentNomenclatureId}`;
      duplicateKeyCounts.set(dedupKey, (duplicateKeyCounts.get(dedupKey) ?? 0) + 1);
      if (!duplicateKeyExample.has(dedupKey)) {
        duplicateKeyExample.set(dedupKey, {
          variantGroup: line.variantGroup,
          componentType: line.componentType,
          componentNomenclatureId: line.componentNomenclatureId,
        });
      }
    }
    const duplicates: string[] = [];
    for (const [dedupKey, count] of duplicateKeyCounts.entries()) {
      if (count <= 1) continue;
      const ex = duplicateKeyExample.get(dedupKey);
      if (!ex) continue;
      const nomLabel = nomenclatureById.get(ex.componentNomenclatureId)?.name || nomenclatureById.get(ex.componentNomenclatureId)?.code || ex.componentNomenclatureId;
      const variantLabel = ex.variantGroup ?? 'основной';
      duplicates.push(`вариант=«${variantLabel}», тип=«${ex.componentType}», номенклатура=«${nomLabel}» (повторов: ${count})`);
    }
    if (duplicates.length > 0) {
      return {
        ok: false,
        error: `BOM не сохранен: обнаружены дубли строк (${duplicates.join('; ')}). Удалите дубль перед сохранением.`,
      };
    }

    // G8: normPercent живёт в notes-мете. Клиенты, не знающие поля, не шлют его вовсе —
    // наследуем от существующей строки по ключу (variantGroup, componentType, номенклатура),
    // чтобы сохранение BOM старым клиентом не срезало типизированные нормы молча.
    const existingNormByKey = new Map<string, number>();
    const existingLineRows = (await db
      .select({
        variantGroup: erpEngineAssemblyBomLines.variantGroup,
        componentType: erpEngineAssemblyBomLines.componentType,
        componentNomenclatureId: erpEngineAssemblyBomLines.componentNomenclatureId,
        notes: erpEngineAssemblyBomLines.notes,
      })
      .from(erpEngineAssemblyBomLines)
      .where(and(eq(erpEngineAssemblyBomLines.bomId, id), isNull(erpEngineAssemblyBomLines.deletedAt)))) as Array<{
      variantGroup: string | null;
      componentType: string;
      componentNomenclatureId: string;
      notes: string | null;
    }>;
    for (const row of existingLineRows) {
      const pct = parseWarehouseBomLineMeta(row.notes).normPercent;
      if (pct == null) continue;
      // Ключ без componentType: auto-fix типа компонента (v1.21.3) не должен рвать наследование.
      existingNormByKey.set(`${row.variantGroup ?? ''}::${row.componentNomenclatureId}`, pct);
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
        normPercent:
          line.normPercentInput !== undefined
            ? line.normPercentInput
            : existingNormByKey.get(`${line.variantGroup ?? ''}::${line.componentNomenclatureId}`) ?? null,
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
          positionKey: line.positionKey,
          positionLabel: line.positionLabel,
          isDefaultOption: line.isDefaultOption,
          createdAt: line.createdAt,
          updatedAt: line.updatedAt,
          deletedAt: line.deletedAt,
          syncStatus: line.syncStatus,
          lastServerSeq: line.lastServerSeq,
        })),
      );
    }

    const clearedDefaultLinks = requestedDefaultBrandIds && requestedDefaultBrandIds.size > 0
      ? await db
          .select()
          .from(erpEngineAssemblyBomBrandLinks)
          .where(
            and(
              inArray(erpEngineAssemblyBomBrandLinks.engineBrandId, [...requestedDefaultBrandIds] as any),
              eq(erpEngineAssemblyBomBrandLinks.isDefaultForBrand, true),
              ne(erpEngineAssemblyBomBrandLinks.bomId, id as any),
              isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
            ),
          )
      : [];
    if (clearedDefaultLinks.length > 0) {
      await db
        .update(erpEngineAssemblyBomBrandLinks)
        .set({ isDefaultForBrand: false, updatedAt: ts, syncStatus: 'synced' })
        .where(inArray(erpEngineAssemblyBomBrandLinks.id, clearedDefaultLinks.map((link) => link.id) as any));
    }

    // Синхронизируем junction-таблицу марок: софт-удаляем те, что больше не указаны, апсертим новые/обновлённые.
    const existingLinks = await db
      .select({
        id: erpEngineAssemblyBomBrandLinks.id,
        engineBrandId: erpEngineAssemblyBomBrandLinks.engineBrandId,
        isDefaultForBrand: erpEngineAssemblyBomBrandLinks.isDefaultForBrand,
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
      isDefaultForBrand: boolean;
      createdAt: number;
      updatedAt: number;
      deletedAt: number | null;
      syncStatus: 'synced';
      lastServerSeq: null;
    }> = [];
    const linksToUpdate: Array<{ id: string; engineBrandId: string; isPrimary: boolean; isDefaultForBrand: boolean }> = [];
    for (const [idx, brandId] of requestedBrandIds.entries()) {
      const isPrimary = idx === 0;
      const existingLinkId = existingByBrand.get(brandId);
      const existingLink = existingLinks.find((link) => String(link.engineBrandId) === brandId);
      const isDefaultForBrand = requestedDefaultBrandIds
        ? requestedDefaultBrandIds.has(brandId)
        : Boolean(existingLink?.isDefaultForBrand);
      if (existingLinkId) {
        linksToUpdate.push({ id: existingLinkId, engineBrandId: brandId, isPrimary, isDefaultForBrand });
      } else {
        linksToInsert.push({
          id: randomUUID(),
          bomId: id,
          engineBrandId: brandId,
          isPrimary,
          isDefaultForBrand,
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
        .set({ isPrimary: update.isPrimary, isDefaultForBrand: update.isDefaultForBrand, updatedAt: ts, syncStatus: 'synced' })
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
            default_variant_key: row.defaultVariantKey ?? null,
            execution_profile_json: row.executionProfileJson ?? null,
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
            is_default_for_brand: Boolean(link.isDefaultForBrand),
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
    if (clearedDefaultLinks.length > 0) {
      const actorPayload = { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' };
      signAndAppendDetailed(
        clearedDefaultLinks.map((link) => ({
          type: 'upsert' as const,
          table: LedgerTableName.ErpEngineAssemblyBomBrandLinks,
          row_id: String(link.id),
          row: {
            id: String(link.id),
            bom_id: String(link.bomId),
            engine_brand_id: String(link.engineBrandId),
            is_primary: Boolean(link.isPrimary),
            is_default_for_brand: false,
            created_at: Number(link.createdAt),
            updated_at: ts,
            deleted_at: null,
            sync_status: 'synced',
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
            position_key: line.positionKey ?? null,
            position_label: line.positionLabel ?? null,
            is_default_option: Boolean(line.isDefaultOption),
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

    // Гарантия согласованности «BOM-деталь ↔ деталь марки» (директива brain bom-parts, интерпретация A):
    // каждая деталь активного BOM заведена как деталь его марок (видна в карточке марки, приходуется
    // при разборке как деталь марки). Best-effort — сбой гарантии не должен ронять сохранение BOM.
    // Steady-state (деталь уже заведена) — только SELECT'ы; ledger-подпись лишь для новых компонентов.
    try {
      const hookActor: AuthUser = { id: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'system' };
      const qtyByNom = new Map<string, Map<string, number>>();
      for (const line of savedLines) {
        const nomId = String(line.componentNomenclatureId);
        const qty = Number(line.qtyPerUnit) || 1;
        const byBrand = qtyByNom.get(nomId) ?? new Map<string, number>();
        for (const brandId of requestedBrandIds) byBrand.set(brandId, Math.max(byBrand.get(brandId) ?? 0, qty));
        qtyByNom.set(nomId, byBrand);
      }
      for (const [nomId, byBrand] of qtyByNom) {
        await ensureNomenclatureBrandPart(hookActor, nomId, byBrand).catch((e) =>
          console.warn(`[bom-parts] guarantee: nom ${nomId} в BOM ${id}: ${String(e)}`),
        );
      }
    } catch (e) {
      console.warn(`[bom-parts] guarantee hook BOM ${id}: ${String(e)}`);
    }

    return { ok: true, id, ...(warnings.length > 0 ? { warnings } : {}) };
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
        position_key: line.positionKey ?? null,
        position_label: line.positionLabel ?? null,
        is_default_option: Boolean(line.isDefaultOption),
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
        is_default_for_brand: Boolean(link.isDefaultForBrand),
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
            default_variant_key: row.defaultVariantKey ?? null,
            execution_profile_json: row.executionProfileJson ?? null,
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
            position_key: line.positionKey ?? null,
            position_label: line.positionLabel ?? null,
            is_default_option: Boolean(line.isDefaultOption),
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
      if (warehouseSet && !warehouseSet.has(String(row.warehouseLocationId ?? ''))) continue;
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
      if (warehouseSet && !warehouseSet.has(String(row.warehouseLocationId ?? ''))) continue;
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


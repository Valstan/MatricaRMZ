import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';
import { PART_TEMPLATE_ID_ATTR_CODE, WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART } from '@matricarmz/shared';

import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  erpCounterparties,
  erpDocumentHeaders,
  erpDocumentLines,
  erpEmployeeCards,
  erpJournalDocuments,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';

const STOCK_DOC_TYPES = ['stock_receipt', 'stock_issue', 'stock_transfer', 'stock_writeoff', 'stock_inventory'] as const;
type StockDocType = (typeof STOCK_DOC_TYPES)[number];

type ResultOk<T> = { ok: true } & T;
type ResultErr = { ok: false; error: string };
type Result<T> = ResultOk<T> | ResultErr;

type Actor = { id: string; username: string; role?: string };

type DocLineInput = {
  qty: number;
  price?: number | null;
  partCardId?: string | null;
  nomenclatureId?: string | null;
  warehouseId?: string | null;
  fromWarehouseId?: string | null;
  toWarehouseId?: string | null;
  adjustmentQty?: number | null;
  bookQty?: number | null;
  actualQty?: number | null;
  reason?: string | null;
  payloadJson?: string | null;
};

type HeaderPayloadInput = {
  warehouseId?: string | null;
  reason?: string | null;
  counterpartyId?: string | null;
};

type LookupOption = {
  id: string;
  label: string;
  code: string | null;
  meta?: Record<string, unknown>;
};

type PlannedMovement = {
  nomenclatureId: string;
  warehouseId: string;
  movementType: string;
  direction: 'in' | 'out';
  qty: number;
  delta: number;
  reason: string | null;
  counterpartyId: string | null;
};

const PART_DETAILS_GROUP_NAME = 'Детали';

function nomenclatureRowIsLinkedPart(specJson: string | null | undefined): boolean {
  const spec = parseJsonObject(specJson ?? null);
  return strField(spec, 'source') === WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART;
}

function nowMs() {
  return Date.now();
}

function isStockDocType(value: string): value is StockDocType {
  return (STOCK_DOC_TYPES as readonly string[]).includes(value);
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function strField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  const asNum = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(asNum) ? asNum : undefined;
}

function parseJsonScalar(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (parsed == null) return null;
    if (typeof parsed === 'string') {
      const trimmed = parsed.trim();
      return trimmed ? trimmed : null;
    }
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
    return null;
  } catch {
    const trimmed = String(raw).trim();
    return trimmed ? trimmed : null;
  }
}

function buildLookupMap(rows: LookupOption[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function readLookupLabel(rows: Map<string, LookupOption>, id: string | null | undefined): string | null {
  const safeId = String(id ?? '').trim();
  if (!safeId) return null;
  return rows.get(safeId)?.label ?? null;
}

async function listMasterdataLookup(typeCode: string): Promise<LookupOption[]> {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, typeCode), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : '';
  if (!typeId) return [];

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)))
    .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code));
  const defById = new Map(defs.map((def) => [String(def.id), String(def.code)]));
  const knownCodes = new Set(defs.map((def) => String(def.code)));

  const rows = await db
    .select({ id: entities.id, updatedAt: entities.updatedAt })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
    .orderBy(asc(entities.updatedAt));
  if (!rows.length) return [];

  const entityIds = rows.map((row) => String(row.id));
  const defIds = defs.map((def) => String(def.id));
  const values =
    defIds.length > 0
      ? await db
          .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(
            and(
              inArray(attributeValues.entityId, entityIds as any),
              inArray(attributeValues.attributeDefId, defIds as any),
              isNull(attributeValues.deletedAt),
            ),
          )
      : [];

  const attrsByEntity = new Map<string, Record<string, string | null>>();
  for (const row of values) {
    const entityId = String(row.entityId);
    const attrCode = defById.get(String(row.attributeDefId));
    if (!attrCode) continue;
    const current = attrsByEntity.get(entityId) ?? {};
    current[attrCode] = parseJsonScalar(row.valueJson);
    attrsByEntity.set(entityId, current);
  }

  const labelCode = ['name', 'title', 'label'].find((code) => knownCodes.has(code)) ?? (knownCodes.has('code') ? 'code' : null);
  return rows
    .map((row) => {
      const entityId = String(row.id);
      const attrs = attrsByEntity.get(entityId) ?? {};
      const label = String((labelCode ? attrs[labelCode] : null) ?? attrs.code ?? entityId).trim();
      const code = attrs.code ?? null;
      const meta = Object.fromEntries(
        Object.entries({
          address: attrs.address ?? null,
          description: attrs.description ?? null,
        }).filter((entry) => entry[1] != null),
      );
      return {
        id: entityId,
        label,
        code,
        ...(Object.keys(meta).length ? { meta } : {}),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label, 'ru'));
}

function ensureDefaultWarehouse(rows: LookupOption[]): LookupOption[] {
  if (rows.some((row) => row.id === 'default')) return rows;
  return [{ id: 'default', label: 'Основной склад', code: 'default' }, ...rows];
}

async function ensurePartNomenclatureGroup(): Promise<string | null> {
  const ts = nowMs();
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'nomenclature_group'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : '';
  if (!typeId) return null;

  const attrRows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)));
  const nameDefId = attrRows.find((row) => String(row.code) === 'name')?.id;
  const kindDefId = attrRows.find((row) => String(row.code) === 'kind')?.id;
  if (!nameDefId) return null;

  const rows = await db
    .select({ id: entities.id, valueJson: attributeValues.valueJson })
    .from(entities)
    .innerJoin(attributeValues, and(eq(attributeValues.entityId, entities.id), eq(attributeValues.attributeDefId, nameDefId as any)))
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt), isNull(attributeValues.deletedAt)));
  const existing = rows.find((row) => parseJsonScalar(row.valueJson) === PART_DETAILS_GROUP_NAME);
  if (existing?.id) return String(existing.id);

  const entityId = randomUUID();
  await db.insert(entities).values({
    id: entityId,
    typeId: typeId as any,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await db.insert(attributeValues).values({
    id: randomUUID(),
    entityId: entityId as any,
    attributeDefId: nameDefId as any,
    valueJson: JSON.stringify(PART_DETAILS_GROUP_NAME),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  if (kindDefId) {
    await db.insert(attributeValues).values({
      id: randomUUID(),
      entityId: entityId as any,
      attributeDefId: kindDefId as any,
      valueJson: JSON.stringify('Продукция'),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
  }
  return entityId;
}

async function syncPartsToWarehouseNomenclature(args: { detailsGroupId: string | null }) {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'part'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const partTypeId = typeRows[0]?.id ? String(typeRows[0].id) : '';
  if (!partTypeId) return;

  const partDefs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, partTypeId as any), isNull(attributeDefs.deletedAt)));
  const nameDefId = partDefs.find((row) => String(row.code) === 'name')?.id;
  const articleDefId = partDefs.find((row) => String(row.code) === 'article')?.id;
  const templateDefId = partDefs.find((row) => String(row.code) === PART_TEMPLATE_ID_ATTR_CODE)?.id;
  if (!nameDefId) return;

  const partRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, partTypeId as any), isNull(entities.deletedAt)));
  if (!partRows.length) return;

  const partIds = partRows.map((row) => String(row.id));
  const defIds = [nameDefId, articleDefId, templateDefId].filter((v): v is string => Boolean(v)).map((v) => String(v));
  const valRows =
    defIds.length > 0
      ? await db
          .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, partIds as any), inArray(attributeValues.attributeDefId, defIds as any), isNull(attributeValues.deletedAt)))
      : [];
  const attrsByPart = new Map<string, Record<string, string | null>>();
  const codeByDefId = new Map(
    partDefs
      .filter((row) => defIds.includes(String(row.id)))
      .map((row) => [String(row.id), String(row.code)] as const),
  );
  for (const row of valRows) {
    const partId = String(row.entityId);
    const code = codeByDefId.get(String(row.attributeDefId));
    if (!code) continue;
    const bag = attrsByPart.get(partId) ?? {};
    bag[code] = parseJsonScalar(row.valueJson);
    attrsByPart.set(partId, bag);
  }

  const existingRows =
    partIds.length > 0
      ? await db
          .select()
          .from(erpNomenclature)
          .where(and(inArray(erpNomenclature.id, partIds as any), isNull(erpNomenclature.deletedAt)))
      : [];
  const existingById = new Map(existingRows.map((row) => [String(row.id), row]));

  const ts = nowMs();
  for (const partId of partIds) {
    const attrs = attrsByPart.get(partId) ?? {};
    const name = String(attrs.name ?? '').trim() || `Деталь ${partId.slice(0, 8)}`;
    const article = String(attrs.article ?? '').trim();
    const templateId = String(attrs[PART_TEMPLATE_ID_ATTR_CODE] ?? '').trim();
    const specJson = JSON.stringify({
      source: WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART,
      partId,
      ...(templateId ? { templateId } : {}),
      ...(article ? { article } : {}),
    });
    const code = article || `DET-${partId.slice(0, 8).toUpperCase()}`;
    const existing = existingById.get(partId);
    const upsertRes = await upsertWarehouseNomenclature({
      id: partId,
      code,
      name,
      itemType: 'product',
      groupId: args.detailsGroupId ?? null,
      unitId: existing?.unitId ?? null,
      barcode: existing?.barcode ?? null,
      minStock: existing?.minStock ?? null,
      maxStock: existing?.maxStock ?? null,
      defaultWarehouseId: existing?.defaultWarehouseId ?? null,
      specJson,
      isActive: true,
      _syncFromPart: true,
    });
    if (!upsertRes.ok) {
      // eslint-disable-next-line no-console
      console.warn('[warehouse] part→nomenclature mirror failed', partId, upsertRes.error);
    }
  }

  const activePartSet = new Set(partIds);
  const mirrorCandidates = await db
    .select({ id: erpNomenclature.id, specJson: erpNomenclature.specJson })
    .from(erpNomenclature)
    .where(isNull(erpNomenclature.deletedAt));
  for (const row of mirrorCandidates) {
    if (!nomenclatureRowIsLinkedPart(row.specJson)) continue;
    const spec = parseJsonObject(row.specJson);
    const pid = strField(spec, 'partId') ?? String(row.id);
    if (activePartSet.has(pid)) continue;
    const delRes = await deleteWarehouseNomenclature({ id: String(row.id), allowLinkedPartMirror: true });
    if (!delRes.ok) {
      // eslint-disable-next-line no-console
      console.warn('[warehouse] failed to retire part nomenclature mirror', row.id, delRes.error);
    }
  }
}

async function listWarehouseReferenceData() {
  await ensurePartNomenclatureGroup();
  const [warehousesRaw, nomenclatureGroups, units, writeoffReasons, counterpartiesRows, employeesRows] = await Promise.all([
    listMasterdataLookup('warehouse_ref'),
    listMasterdataLookup('nomenclature_group'),
    listMasterdataLookup('unit'),
    listMasterdataLookup('stock_write_off_reason'),
    db.select().from(erpCounterparties).where(isNull(erpCounterparties.deletedAt)).orderBy(asc(erpCounterparties.name)),
    db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).orderBy(asc(erpEmployeeCards.fullName)),
  ]);

  const warehouses = ensureDefaultWarehouse(warehousesRaw);
  const counterparties: LookupOption[] = counterpartiesRows.map((row) => ({
    id: String(row.id),
    label: String(row.name),
    code: row.code == null ? null : String(row.code),
  }));
  const employees: LookupOption[] = employeesRows.map((row) => ({
    id: String(row.id),
    label: String(row.fullName),
    code: row.personnelNo == null ? null : String(row.personnelNo),
  }));

  return {
    warehouses,
    nomenclatureGroups,
    units,
    writeoffReasons,
    counterparties,
    employees,
    warehouseById: buildLookupMap(warehouses),
    groupById: buildLookupMap(nomenclatureGroups),
    unitById: buildLookupMap(units),
    writeoffReasonById: buildLookupMap(writeoffReasons),
    counterpartyById: buildLookupMap(counterparties),
    employeeById: buildLookupMap(employees),
  };
}

function parseWarehouseHeaderPayload(raw: string | null | undefined) {
  const payload = parseJsonObject(raw);
  return {
    warehouseId: strField(payload, 'warehouseId') ?? null,
    reason: strField(payload, 'reason') ?? null,
    counterpartyId: strField(payload, 'counterpartyId') ?? null,
  };
}

function parseWarehouseLinePayload(raw: string | null | undefined) {
  const payload = parseJsonObject(raw);
  return {
    nomenclatureId: strField(payload, 'nomenclatureId') ?? null,
    warehouseId: strField(payload, 'warehouseId') ?? null,
    fromWarehouseId: strField(payload, 'fromWarehouseId') ?? null,
    toWarehouseId: strField(payload, 'toWarehouseId') ?? null,
    adjustmentQty: numField(payload, 'adjustmentQty') ?? null,
    bookQty: numField(payload, 'bookQty') ?? null,
    actualQty: numField(payload, 'actualQty') ?? null,
    reason: strField(payload, 'reason') ?? null,
  };
}

function mergeHeaderPayloadJson(raw: string | null | undefined, input?: HeaderPayloadInput | null) {
  const payload = parseJsonObject(raw);
  if (input?.warehouseId !== undefined) payload.warehouseId = input.warehouseId;
  if (input?.reason !== undefined) payload.reason = input.reason;
  if (input?.counterpartyId !== undefined) payload.counterpartyId = input.counterpartyId;
  const compact = Object.fromEntries(Object.entries(payload).filter((entry) => entry[1] != null && entry[1] !== ''));
  return Object.keys(compact).length > 0 ? JSON.stringify(compact) : null;
}

function mergeLinePayloadJson(raw: string | null | undefined, input: DocLineInput) {
  const payload = parseJsonObject(raw);
  if (input.nomenclatureId !== undefined) payload.nomenclatureId = input.nomenclatureId;
  if (input.warehouseId !== undefined) payload.warehouseId = input.warehouseId;
  if (input.fromWarehouseId !== undefined) payload.fromWarehouseId = input.fromWarehouseId;
  if (input.toWarehouseId !== undefined) payload.toWarehouseId = input.toWarehouseId;
  if (input.adjustmentQty !== undefined) payload.adjustmentQty = input.adjustmentQty;
  if (input.bookQty !== undefined) payload.bookQty = input.bookQty;
  if (input.actualQty !== undefined) payload.actualQty = input.actualQty;
  if (input.reason !== undefined) payload.reason = input.reason;
  const compact = Object.fromEntries(Object.entries(payload).filter((entry) => entry[1] != null && entry[1] !== ''));
  return Object.keys(compact).length > 0 ? JSON.stringify(compact) : null;
}

export async function listWarehouseLookups(): Promise<
  Result<{
    lookups: {
      warehouses: LookupOption[];
      nomenclatureGroups: LookupOption[];
      units: LookupOption[];
      writeoffReasons: LookupOption[];
      counterparties: LookupOption[];
      employees: LookupOption[];
    };
  }>
> {
  try {
    const refs = await listWarehouseReferenceData();
    return {
      ok: true,
      lookups: {
        warehouses: refs.warehouses,
        nomenclatureGroups: refs.nomenclatureGroups,
        units: refs.units,
        writeoffReasons: refs.writeoffReasons,
        counterparties: refs.counterparties,
        employees: refs.employees,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseNomenclature(args?: {
  search?: string;
  itemType?: string;
  groupId?: string;
  isActive?: boolean;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const detailsGroupId = await ensurePartNomenclatureGroup();
    await syncPartsToWarehouseNomenclature({ detailsGroupId });
    const refs = await listWarehouseReferenceData();
    const search = String(args?.search ?? '').trim().toLowerCase();
    const rows = await db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt)).orderBy(asc(erpNomenclature.name));
    const filtered = rows.filter((row) => {
      if (args?.itemType && String(row.itemType) !== String(args.itemType)) return false;
      if (args?.groupId && String(row.groupId ?? '') !== String(args.groupId)) return false;
      if (args?.isActive !== undefined && Boolean(row.isActive) !== Boolean(args.isActive)) return false;
      if (!search) return true;
      const hay = `${String(row.code ?? '')} ${String(row.name ?? '')} ${String(row.barcode ?? '')}`.toLowerCase();
      return hay.includes(search);
    });
    return {
      ok: true,
      rows: filtered.map((row) => ({
        ...row,
        groupName: readLookupLabel(refs.groupById, row.groupId == null ? null : String(row.groupId)),
        unitName: readLookupLabel(refs.unitById, row.unitId == null ? null : String(row.unitId)),
        defaultWarehouseName: readLookupLabel(refs.warehouseById, row.defaultWarehouseId == null ? null : String(row.defaultWarehouseId)),
      })) as Array<Record<string, unknown>>,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseNomenclature(args: {
  id?: string;
  code: string;
  name: string;
  itemType?: string;
  groupId?: string | null;
  unitId?: string | null;
  barcode?: string | null;
  minStock?: number | null;
  maxStock?: number | null;
  defaultWarehouseId?: string | null;
  specJson?: string | null;
  isActive?: boolean;
  /** Внутренний вызов: зеркало карточки детали в номенклатуре склада */
  _syncFromPart?: boolean;
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id || randomUUID());
    if (!args._syncFromPart) {
      const prevRows = await db
        .select({ specJson: erpNomenclature.specJson })
        .from(erpNomenclature)
        .where(and(eq(erpNomenclature.id, id), isNull(erpNomenclature.deletedAt)))
        .limit(1);
      if (prevRows[0] && nomenclatureRowIsLinkedPart(prevRows[0].specJson)) {
        return {
          ok: false,
          error:
            'Позиция привязана к детали (Производство). Редактируйте карточку детали — складская номенклатура обновится автоматически.',
        };
      }
    }
    const ts = nowMs();
    const normalized = {
      code: String(args.code).trim(),
      name: String(args.name).trim(),
      itemType: String(args.itemType || 'material'),
      groupId: args.groupId ?? null,
      unitId: args.unitId ?? null,
      barcode: args.barcode ?? null,
      minStock: args.minStock == null ? null : Math.trunc(Number(args.minStock)),
      maxStock: args.maxStock == null ? null : Math.trunc(Number(args.maxStock)),
      defaultWarehouseId: args.defaultWarehouseId ?? null,
      specJson: args.specJson ?? null,
      isActive: args.isActive ?? true,
    };
    await db
      .insert(erpNomenclature)
      .values({ id, ...normalized, createdAt: ts, updatedAt: ts, deletedAt: null })
      .onConflictDoUpdate({ target: erpNomenclature.id, set: { ...normalized, updatedAt: ts, deletedAt: null } });
    const saved = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpNomenclature,
          row_id: id,
          row: {
            id: String(row.id),
            code: String(row.code),
            name: String(row.name),
            item_type: String(row.itemType),
            group_id: row.groupId,
            unit_id: row.unitId,
            barcode: row.barcode,
            min_stock: row.minStock,
            max_stock: row.maxStock,
            default_warehouse_id: row.defaultWarehouseId,
            spec_json: row.specJson,
            is_active: Boolean(row.isActive),
            created_at: Number(row.createdAt),
            updated_at: Number(row.updatedAt),
            deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteWarehouseNomenclature(args: {
  id: string;
  /** Внутренний вызов при удалении детали — снять только зеркало в erp_nomenclature */
  allowLinkedPartMirror?: boolean;
}): Promise<Result<{ id: string }>> {
  try {
    if (!args.allowLinkedPartMirror) {
      const prevRows = await db.select({ specJson: erpNomenclature.specJson }).from(erpNomenclature).where(eq(erpNomenclature.id, args.id)).limit(1);
      if (prevRows[0] && nomenclatureRowIsLinkedPart(prevRows[0].specJson)) {
        return {
          ok: false,
          error: 'Нельзя удалить зеркальную позицию детали из склада. Удалите деталь в разделе Производство или скройте деталь там.',
        };
      }
    }
    const ts = nowMs();
    await db.update(erpNomenclature).set({ isActive: false, deletedAt: ts, updatedAt: ts }).where(eq(erpNomenclature.id, args.id));
    const saved = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, args.id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'delete',
          table: LedgerTableName.ErpNomenclature,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            code: String(row.code),
            name: String(row.name),
            item_type: String(row.itemType),
            group_id: row.groupId,
            unit_id: row.unitId,
            barcode: row.barcode,
            min_stock: row.minStock,
            max_stock: row.maxStock,
            default_warehouse_id: row.defaultWarehouseId,
            spec_json: row.specJson,
            is_active: false,
            created_at: Number(row.createdAt),
            updated_at: ts,
            deleted_at: ts,
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id: args.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseStock(args?: {
  warehouseId?: string;
  nomenclatureId?: string;
  search?: string;
  lowStockOnly?: boolean;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const rows = await db.select().from(erpRegStockBalance).orderBy(asc(erpRegStockBalance.warehouseId));
    const nomenclatureIds = Array.from(new Set(rows.map((row) => row.nomenclatureId).filter((v): v is string => typeof v === 'string' && v.length > 0)));
    const nomenclatureRows =
      nomenclatureIds.length === 0
        ? []
        : await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds), isNull(erpNomenclature.deletedAt)));
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const search = String(args?.search ?? '').trim().toLowerCase();
    const filtered = rows
      .filter((row) => {
        if (args?.warehouseId && String(row.warehouseId) !== String(args.warehouseId)) return false;
        if (args?.nomenclatureId && String(row.nomenclatureId ?? '') !== String(args.nomenclatureId)) return false;
        const n = row.nomenclatureId ? nomenclatureById.get(String(row.nomenclatureId)) : undefined;
        if (search) {
          const hay = `${String(n?.code ?? '')} ${String(n?.name ?? '')} ${String(row.warehouseId)}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        if (args?.lowStockOnly) {
          const min = Number(n?.minStock ?? NaN);
          if (!Number.isFinite(min)) return false;
          if (Number(row.qty) > min) return false;
        }
        return true;
      })
      .map((row) => {
        const n = row.nomenclatureId ? nomenclatureById.get(String(row.nomenclatureId)) : undefined;
        const reservedQty = Number(row.reservedQty ?? 0);
        const qty = Number(row.qty ?? 0);
        return {
          ...row,
          warehouseName: readLookupLabel(refs.warehouseById, String(row.warehouseId)),
          nomenclatureCode: n?.code ?? null,
          nomenclatureName: n?.name ?? null,
          itemType: n?.itemType ?? null,
          minStock: n?.minStock ?? null,
          maxStock: n?.maxStock ?? null,
          groupId: n?.groupId ?? null,
          groupName: readLookupLabel(refs.groupById, n?.groupId == null ? null : String(n.groupId)),
          unitId: n?.unitId ?? null,
          unitName: readLookupLabel(refs.unitById, n?.unitId == null ? null : String(n.unitId)),
          defaultWarehouseId: n?.defaultWarehouseId ?? null,
          defaultWarehouseName: readLookupLabel(refs.warehouseById, n?.defaultWarehouseId == null ? null : String(n.defaultWarehouseId)),
          reservedQty,
          availableQty: qty - reservedQty,
        };
      });
    return { ok: true, rows: filtered as Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseDocuments(args?: {
  docType?: string;
  status?: string;
  fromDate?: number;
  toDate?: number;
  search?: string;
  warehouseId?: string;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const rows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(isNull(erpDocumentHeaders.deletedAt))
      .orderBy(desc(erpDocumentHeaders.docDate), desc(erpDocumentHeaders.createdAt));
    const headerIds = rows.filter((row) => isStockDocType(String(row.docType))).map((row) => String(row.id));
    const lineRows =
      headerIds.length > 0
        ? await db
            .select()
            .from(erpDocumentLines)
            .where(and(inArray(erpDocumentLines.headerId, headerIds as any), isNull(erpDocumentLines.deletedAt)))
            .orderBy(asc(erpDocumentLines.lineNo))
        : [];
    const linesByHeaderId = new Map<string, typeof lineRows>();
    for (const line of lineRows) {
      const key = String(line.headerId);
      const list = linesByHeaderId.get(key) ?? [];
      list.push(line);
      linesByHeaderId.set(key, list);
    }
    const search = String(args?.search ?? '').trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (!isStockDocType(String(row.docType))) return false;
      if (args?.docType && String(row.docType) !== String(args.docType)) return false;
      if (args?.status && String(row.status) !== String(args.status)) return false;
      if (args?.fromDate !== undefined && Number(row.docDate) < Number(args.fromDate)) return false;
      if (args?.toDate !== undefined && Number(row.docDate) > Number(args.toDate)) return false;
      const headerPayload = parseWarehouseHeaderPayload(row.payloadJson);
      if (args?.warehouseId && String(headerPayload.warehouseId ?? '') !== String(args.warehouseId)) return false;
      if (search) {
        const hay = [
          String(row.docNo ?? ''),
          String(row.docType ?? ''),
          String(headerPayload.reason ?? ''),
          String(headerPayload.warehouseId ?? ''),
          String(readLookupLabel(refs.warehouseById, headerPayload.warehouseId) ?? ''),
          String(readLookupLabel(refs.counterpartyById, headerPayload.counterpartyId) ?? ''),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    return {
      ok: true,
      rows: filtered.map((row) => {
        const headerPayload = parseWarehouseHeaderPayload(row.payloadJson);
        const docLines = linesByHeaderId.get(String(row.id)) ?? [];
        const reasonLabel = readLookupLabel(refs.writeoffReasonById, headerPayload.reason) ?? headerPayload.reason;
        return {
          ...row,
          warehouseId: headerPayload.warehouseId,
          warehouseName: readLookupLabel(refs.warehouseById, headerPayload.warehouseId),
          reason: headerPayload.reason,
          reasonLabel,
          counterpartyId: headerPayload.counterpartyId,
          counterpartyName: readLookupLabel(refs.counterpartyById, headerPayload.counterpartyId),
          authorName: readLookupLabel(refs.employeeById, row.authorId == null ? null : String(row.authorId)),
          linesCount: docLines.length,
          totalQty: docLines.reduce((sum, line) => sum + Number(line.qty ?? 0), 0),
        };
      }) as Array<Record<string, unknown>>,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getWarehouseDocument(args: {
  id: string;
}): Promise<Result<{ document: { header: Record<string, unknown>; lines: Array<Record<string, unknown>> } }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const headerRows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.id), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headerRows[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (!isStockDocType(String(header.docType))) return { ok: false, error: 'Документ не складского типа' };
    const lines = await db
      .select()
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.id), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));
    const headerPayload = parseWarehouseHeaderPayload(header.payloadJson);
    const nomenclatureIds = Array.from(
      new Set(
        lines
          .map((line) => parseWarehouseLinePayload(line.payloadJson).nomenclatureId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    );
    const nomenclatureRows =
      nomenclatureIds.length > 0
        ? await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds as any), isNull(erpNomenclature.deletedAt)))
        : [];
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    return {
      ok: true,
      document: {
        header: {
          ...header,
          warehouseId: headerPayload.warehouseId,
          warehouseName: readLookupLabel(refs.warehouseById, headerPayload.warehouseId),
          reason: headerPayload.reason,
          reasonLabel: readLookupLabel(refs.writeoffReasonById, headerPayload.reason) ?? headerPayload.reason,
          counterpartyId: headerPayload.counterpartyId,
          counterpartyName: readLookupLabel(refs.counterpartyById, headerPayload.counterpartyId),
          authorName: readLookupLabel(refs.employeeById, header.authorId == null ? null : String(header.authorId)),
          linesCount: lines.length,
          totalQty: lines.reduce((sum, line) => sum + Number(line.qty ?? 0), 0),
        },
        lines: lines.map((line) => {
          const payload = parseWarehouseLinePayload(line.payloadJson);
          const nomenclature = payload.nomenclatureId ? nomenclatureById.get(payload.nomenclatureId) : null;
          return {
            ...line,
            nomenclatureId: payload.nomenclatureId,
            nomenclatureCode: nomenclature?.code ?? null,
            nomenclatureName: nomenclature?.name ?? null,
            warehouseId: payload.warehouseId,
            warehouseName: readLookupLabel(refs.warehouseById, payload.warehouseId),
            fromWarehouseId: payload.fromWarehouseId,
            fromWarehouseName: readLookupLabel(refs.warehouseById, payload.fromWarehouseId),
            toWarehouseId: payload.toWarehouseId,
            toWarehouseName: readLookupLabel(refs.warehouseById, payload.toWarehouseId),
            adjustmentQty: payload.adjustmentQty,
            bookQty: payload.bookQty,
            actualQty: payload.actualQty,
            reason: payload.reason,
            reasonLabel: readLookupLabel(refs.writeoffReasonById, payload.reason) ?? payload.reason,
          };
        }),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createWarehouseDocument(args: {
  id?: string;
  docType: string;
  docNo: string;
  docDate?: number;
  departmentId?: string | null;
  authorId?: string | null;
  header?: HeaderPayloadInput | null;
  payloadJson?: string | null;
  lines: DocLineInput[];
  actor: Actor;
}): Promise<Result<{ id: string }>> {
  try {
    if (!isStockDocType(String(args.docType))) return { ok: false, error: 'Неподдерживаемый тип складского документа' };
    const ts = nowMs();
    const id = String(args.id || randomUUID());
    const docDate = Math.trunc(Number(args.docDate ?? ts));
    if (args.id) {
      const existing = await db
        .select({ id: erpDocumentHeaders.id, status: erpDocumentHeaders.status })
        .from(erpDocumentHeaders)
        .where(and(eq(erpDocumentHeaders.id, id), isNull(erpDocumentHeaders.deletedAt)))
        .limit(1);
      if (!existing[0]) return { ok: false, error: 'Документ для обновления не найден' };
      if (String(existing[0].status) !== 'draft') return { ok: false, error: 'Можно редактировать только документ в статусе черновика' };
      await db
        .update(erpDocumentHeaders)
        .set({
          docType: String(args.docType),
          docNo: String(args.docNo),
          docDate,
          authorId: args.authorId ?? null,
          departmentId: args.departmentId ?? null,
          payloadJson: mergeHeaderPayloadJson(args.payloadJson, args.header),
          updatedAt: ts,
        })
        .where(eq(erpDocumentHeaders.id, id));
      await db.update(erpDocumentLines).set({ deletedAt: ts, updatedAt: ts }).where(and(eq(erpDocumentLines.headerId, id), isNull(erpDocumentLines.deletedAt)));
    } else {
      await db.insert(erpDocumentHeaders).values({
        id,
        docType: String(args.docType),
        docNo: String(args.docNo),
        docDate,
        status: 'draft',
        authorId: args.authorId ?? null,
        departmentId: args.departmentId ?? null,
        payloadJson: mergeHeaderPayloadJson(args.payloadJson, args.header),
        createdAt: ts,
        updatedAt: ts,
        postedAt: null,
        deletedAt: null,
      });
    }
    const lines = args.lines.map((line, idx) => {
      return {
        id: randomUUID(),
        headerId: id,
        lineNo: idx + 1,
        partCardId: line.partCardId ?? null,
        qty: Math.max(0, Math.trunc(Number(line.qty))),
        price: line.price == null ? null : Math.trunc(Number(line.price)),
        payloadJson: mergeLinePayloadJson(line.payloadJson, line),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
      };
    });
    if (lines.length > 0) await db.insert(erpDocumentLines).values(lines);
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: id,
      eventType: args.id ? 'updated' : 'created',
      eventPayloadJson: JSON.stringify({ docType: args.docType, by: args.actor.username, lines: lines.length }),
      eventAt: ts,
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function cancelWarehouseDocument(args: {
  documentId: string;
  actor: Actor;
}): Promise<Result<{ id: string; status: 'cancelled' }>> {
  try {
    const ts = nowMs();
    const headerRows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headerRows[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (!isStockDocType(String(header.docType))) return { ok: false, error: 'Документ не складского типа' };
    if (String(header.status) === 'posted') return { ok: false, error: 'Проведенный документ нельзя отменить без сторнирующей операции' };
    if (String(header.status) === 'cancelled') return { ok: true, id: args.documentId, status: 'cancelled' };

    await db.update(erpDocumentHeaders).set({ status: 'cancelled', updatedAt: ts }).where(eq(erpDocumentHeaders.id, args.documentId));
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: args.documentId,
      eventType: 'cancelled',
      eventPayloadJson: JSON.stringify({ by: args.actor.username }),
      eventAt: ts,
    });

    return { ok: true, id: args.documentId, status: 'cancelled' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function postWarehouseDocument(args: {
  documentId: string;
  actor: Actor;
}): Promise<Result<{ id: string; posted: boolean }>> {
  try {
    const ts = nowMs();
    const headers = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headers[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (!isStockDocType(String(header.docType))) return { ok: false, error: 'Документ не складского типа' };
    if (String(header.status) === 'posted') return { ok: true, id: args.documentId, posted: true };

    const headerPayload = parseJsonObject(header.payloadJson ?? null);
    const lines = await db
      .select()
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.documentId), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));
    const planned: PlannedMovement[] = [];

    for (const line of lines) {
      const qty = Math.max(0, Math.trunc(Number(line.qty ?? 0)));
      const payload = parseJsonObject(line.payloadJson ?? null);
      const nomenclatureId = strField(payload, 'nomenclatureId');
      if (!nomenclatureId) return { ok: false, error: `В строке ${line.lineNo} не задана номенклатура` };
      const reason = strField(payload, 'reason') ?? strField(headerPayload, 'reason') ?? null;
      const counterpartyId = strField(headerPayload, 'counterpartyId') ?? null;

      if (String(header.docType) === 'stock_receipt') {
        if (qty <= 0) continue;
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'receipt', direction: 'in', qty, delta: qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_issue') {
        if (qty <= 0) continue;
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'issue', direction: 'out', qty, delta: -qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_writeoff') {
        if (qty <= 0) continue;
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'writeoff', direction: 'out', qty, delta: -qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_transfer') {
        if (qty <= 0) continue;
        const fromWarehouseId = strField(payload, 'fromWarehouseId') ?? strField(headerPayload, 'fromWarehouseId');
        const toWarehouseId = strField(payload, 'toWarehouseId') ?? strField(headerPayload, 'toWarehouseId');
        if (!fromWarehouseId || !toWarehouseId) return { ok: false, error: `В строке ${line.lineNo} не заполнены склады перемещения` };
        if (fromWarehouseId === toWarehouseId) return { ok: false, error: `В строке ${line.lineNo} склады перемещения совпадают` };
        planned.push({ nomenclatureId, warehouseId: fromWarehouseId, movementType: 'transfer_out', direction: 'out', qty, delta: -qty, reason, counterpartyId });
        planned.push({ nomenclatureId, warehouseId: toWarehouseId, movementType: 'transfer_in', direction: 'in', qty, delta: qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_inventory') {
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        const adjustment = numField(payload, 'adjustmentQty');
        const bookQty = numField(payload, 'bookQty');
        const actualQty = numField(payload, 'actualQty');
        const delta = adjustment !== undefined ? Math.trunc(adjustment) : bookQty !== undefined && actualQty !== undefined ? Math.trunc(actualQty - bookQty) : qty;
        if (delta === 0) continue;
        planned.push({
          nomenclatureId,
          warehouseId,
          movementType: delta > 0 ? 'inventory_surplus' : 'inventory_shortage',
          direction: delta > 0 ? 'in' : 'out',
          qty: Math.abs(delta),
          delta,
          reason,
          counterpartyId,
        });
      }
    }

    if (planned.length === 0) {
      return { ok: false, error: 'В документе нет строк с движением по складу' };
    }

    const nomenclatureIds = Array.from(new Set(planned.map((item) => item.nomenclatureId)));
    const existingNomenclature =
      nomenclatureIds.length === 0
        ? []
        : await db.select({ id: erpNomenclature.id }).from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds), isNull(erpNomenclature.deletedAt)));
    if (existingNomenclature.length !== nomenclatureIds.length) return { ok: false, error: 'Не найдена часть номенклатуры документа' };

    const balanceByKey = new Map<string, { id: string; qty: number; reservedQty: number }>();
    for (const movement of planned) {
      const key = `${movement.nomenclatureId}::${movement.warehouseId}`;
      if (balanceByKey.has(key)) continue;
      const balanceRows = await db
        .select()
        .from(erpRegStockBalance)
        .where(and(eq(erpRegStockBalance.nomenclatureId, movement.nomenclatureId), eq(erpRegStockBalance.warehouseId, movement.warehouseId)))
        .limit(1);
      const balance = balanceRows[0];
      balanceByKey.set(key, {
        id: balance?.id ? String(balance.id) : randomUUID(),
        qty: Number(balance?.qty ?? 0),
        reservedQty: Number(balance?.reservedQty ?? 0),
      });
    }

    for (const movement of planned) {
      const key = `${movement.nomenclatureId}::${movement.warehouseId}`;
      const current = balanceByKey.get(key);
      if (!current) return { ok: false, error: 'Ошибка подготовки баланса' };
      const nextQty = current.qty + movement.delta;
      if (nextQty < 0) return { ok: false, error: `Недостаточно остатка для ${movement.nomenclatureId} на складе ${movement.warehouseId}` };
      current.qty = nextQty;
    }

    for (const movement of planned) {
      const key = `${movement.nomenclatureId}::${movement.warehouseId}`;
      const current = balanceByKey.get(key);
      if (!current) continue;
      const existing = await db.select({ id: erpRegStockBalance.id }).from(erpRegStockBalance).where(eq(erpRegStockBalance.id, current.id)).limit(1);
      if (existing[0]) {
        await db.update(erpRegStockBalance).set({ qty: current.qty, reservedQty: current.reservedQty, updatedAt: ts }).where(eq(erpRegStockBalance.id, current.id));
      } else {
        await db.insert(erpRegStockBalance).values({
          id: current.id,
          nomenclatureId: movement.nomenclatureId,
          partCardId: null,
          warehouseId: movement.warehouseId,
          qty: current.qty,
          reservedQty: current.reservedQty,
          updatedAt: ts,
        });
      }
      await db.insert(erpRegStockMovements).values({
        id: randomUUID(),
        nomenclatureId: movement.nomenclatureId,
        warehouseId: movement.warehouseId,
        documentHeaderId: args.documentId,
        movementType: movement.movementType,
        qty: movement.qty,
        direction: movement.direction,
        counterpartyId: movement.counterpartyId,
        reason: movement.reason,
        performedAt: ts,
        performedBy: args.actor.username,
        createdAt: ts,
      });
    }

    await db.update(erpDocumentHeaders).set({ status: 'posted', postedAt: ts, updatedAt: ts }).where(eq(erpDocumentHeaders.id, args.documentId));
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: args.documentId,
      eventType: 'posted',
      eventPayloadJson: JSON.stringify({ by: args.actor.username }),
      eventAt: ts,
    });
    const ledgerPayloads: Array<{
      type: 'upsert';
      table: LedgerTableName;
      row_id: string;
      row: Record<string, unknown>;
      actor: { userId: string; username: string; role: string };
      ts: number;
    }> = [];
    const balanceRows = await db
      .select()
      .from(erpRegStockBalance)
      .where(inArray(erpRegStockBalance.id, Array.from(new Set(Array.from(balanceByKey.values()).map((item) => item.id))) as any));
    for (const balance of balanceRows) {
      ledgerPayloads.push({
        type: 'upsert',
        table: LedgerTableName.ErpRegStockBalance,
        row_id: String(balance.id),
        row: {
          id: String(balance.id),
          nomenclature_id: balance.nomenclatureId,
          part_card_id: balance.partCardId,
          warehouse_id: String(balance.warehouseId),
          qty: Number(balance.qty),
          reserved_qty: Number(balance.reservedQty ?? 0),
          updated_at: Number(balance.updatedAt),
        },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      });
    }
    const movementRows = await db
      .select()
      .from(erpRegStockMovements)
      .where(eq(erpRegStockMovements.documentHeaderId, args.documentId));
    for (const movement of movementRows) {
      ledgerPayloads.push({
        type: 'upsert',
        table: LedgerTableName.ErpRegStockMovements,
        row_id: String(movement.id),
        row: {
          id: String(movement.id),
          nomenclature_id: String(movement.nomenclatureId),
          warehouse_id: String(movement.warehouseId),
          document_header_id: movement.documentHeaderId,
          movement_type: String(movement.movementType),
          qty: Number(movement.qty),
          direction: String(movement.direction),
          counterparty_id: movement.counterpartyId,
          reason: movement.reason,
          performed_at: Number(movement.performedAt),
          performed_by: movement.performedBy,
          created_at: Number(movement.createdAt),
        },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      });
    }
    if (ledgerPayloads.length > 0) signAndAppendDetailed(ledgerPayloads);
    return { ok: true, id: args.documentId, posted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseMovements(args?: {
  nomenclatureId?: string;
  warehouseId?: string;
  documentHeaderId?: string;
  fromDate?: number;
  toDate?: number;
  limit?: number;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const rows = await db.select().from(erpRegStockMovements).orderBy(desc(erpRegStockMovements.performedAt));
    const filtered = rows.filter((row) => {
      if (args?.nomenclatureId && String(row.nomenclatureId) !== String(args.nomenclatureId)) return false;
      if (args?.warehouseId && String(row.warehouseId) !== String(args.warehouseId)) return false;
      if (args?.documentHeaderId && String(row.documentHeaderId ?? '') !== String(args.documentHeaderId)) return false;
      if (args?.fromDate !== undefined && Number(row.performedAt) < Number(args.fromDate)) return false;
      if (args?.toDate !== undefined && Number(row.performedAt) > Number(args.toDate)) return false;
      return true;
    });
    const limit = Math.max(1, Math.min(2000, Number(args?.limit ?? 500)));
    const limited = filtered.slice(0, limit);
    const nomenclatureIds = Array.from(new Set(limited.map((row) => String(row.nomenclatureId)).filter(Boolean)));
    const headerIds = Array.from(new Set(limited.map((row) => String(row.documentHeaderId ?? '')).filter(Boolean)));
    const nomenclatureRows =
      nomenclatureIds.length > 0
        ? await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds as any), isNull(erpNomenclature.deletedAt)))
        : [];
    const headerRows =
      headerIds.length > 0
        ? await db.select().from(erpDocumentHeaders).where(and(inArray(erpDocumentHeaders.id, headerIds as any), isNull(erpDocumentHeaders.deletedAt)))
        : [];
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const headerById = new Map(headerRows.map((row) => [String(row.id), row]));
    return {
      ok: true,
      rows: limited.map((row) => {
        const nomenclature = nomenclatureById.get(String(row.nomenclatureId));
        const header = row.documentHeaderId ? headerById.get(String(row.documentHeaderId)) : null;
        return {
          ...row,
          warehouseName: readLookupLabel(refs.warehouseById, String(row.warehouseId)),
          nomenclatureCode: nomenclature?.code ?? null,
          nomenclatureName: nomenclature?.name ?? null,
          documentDocNo: header?.docNo ?? null,
          documentDocType: header?.docType ?? null,
          counterpartyName: readLookupLabel(refs.counterpartyById, row.counterpartyId == null ? null : String(row.counterpartyId)),
          reasonLabel: readLookupLabel(refs.writeoffReasonById, row.reason == null ? null : String(row.reason)) ?? row.reason ?? null,
        };
      }) as Array<Record<string, unknown>>,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Полная пересборка зеркал деталей в `erp_nomenclature` (группа «Детали», тип изделие). */
export async function refreshPartWarehouseNomenclatureLinks(): Promise<void> {
  const gid = await ensurePartNomenclatureGroup();
  await syncPartsToWarehouseNomenclature({ detailsGroupId: gid });
}

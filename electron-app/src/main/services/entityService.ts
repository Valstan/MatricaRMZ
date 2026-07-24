import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, like, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_RESERVATION_CODE,
  collectContractEntityReferences,
  collectSupplyRequestEntityReferences,
  collectWorkOrderEntityReferences,
} from '@matricarmz/shared';

import { attributeDefs, attributeValues, entities, entityTypes, operations, erpEngineAssemblyBomBrandLinks } from '../database/schema.js';
import type { EntityDetails, EntityListItem, IncomingReferenceGroup } from '@matricarmz/shared';

function nowMs() {
  return Date.now();
}

async function getDefsByType(db: BetterSQLite3Database, entityTypeId: string) {
  const defs = await db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId), isNull(attributeDefs.deletedAt)))
    .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code))
    .limit(5000);
  const byCode: Record<string, string> = {};
  for (const d of defs) byCode[d.code] = d.id;
  return { defs, byCode };
}

async function validateLinkValue(
  db: BetterSQLite3Database,
  def: (typeof attributeDefs.$inferSelect),
  value: unknown,
): Promise<string | null> {
  if (String(def.dataType) !== 'link') return null;
  const ids = (Array.isArray(value) ? value : [value]).map((item) => String(item ?? '').trim()).filter(Boolean);
  if (ids.length === 0) return null;
  const meta = def.metaJson ? safeJsonParse(String(def.metaJson)) : null;
  const expectedType =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? String((meta as Record<string, unknown>).linkTargetTypeCode ?? '').trim()
      : '';
  const rows = await db
    .select({ id: entities.id, typeCode: entityTypes.code })
    .from(entities)
    .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
    .where(and(inArray(entities.id, [...new Set(ids)]), isNull(entities.deletedAt), isNull(entityTypes.deletedAt)));
  const typeById = new Map(rows.map((row) => [String(row.id), String(row.typeCode)]));
  for (const id of ids) {
    const actualType = typeById.get(id);
    if (!actualType) return `${def.code}: связанный элемент ${id} не найден`;
    if (expectedType && actualType !== expectedType) return `${def.code}: ожидался тип ${expectedType}, получен ${actualType}`;
  }
  return null;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function valueToSearchText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => valueToSearchText(item)).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => valueToSearchText(item))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export async function listEntitiesByType(db: BetterSQLite3Database, entityTypeId: string): Promise<EntityListItem[]> {
  const rows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.typeId, entityTypeId), isNull(entities.deletedAt)))
    .orderBy(asc(entities.updatedAt))
    .limit(2000);

  if (rows.length === 0) return [];

  const { defs, byCode } = await getDefsByType(db, entityTypeId);
  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;
  const priceDefId = byCode['price'] ?? null;
  const defIds = defs.map((d) => String(d.id));
  const entityIds = rows.map((row) => String(row.id));

  const valueRows =
    defIds.length > 0
      ? await db
          .select({
            entityId: attributeValues.entityId,
            attributeDefId: attributeValues.attributeDefId,
            valueJson: attributeValues.valueJson,
          })
          .from(attributeValues)
          .where(
            and(
              inArray(attributeValues.entityId, entityIds as any),
              inArray(attributeValues.attributeDefId, defIds as any),
              isNull(attributeValues.deletedAt),
            ),
          )
          // Oldest→newest so the per-(entity,def) map keeps the NEWEST value if stray
          // duplicate rows exist (defensive; setEntityAttribute now collapses them).
          .orderBy(asc(attributeValues.updatedAt))
          .limit(200_000)
      : [];

  const valuesByEntity: Record<string, Record<string, unknown>> = {};
  for (const row of valueRows as any[]) {
    const entityId = String(row.entityId);
    const defId = String(row.attributeDefId);
    if (!valuesByEntity[entityId]) valuesByEntity[entityId] = {};
    valuesByEntity[entityId][defId] = row.valueJson ? safeJsonParse(String(row.valueJson)) : null;
  }

  const out: EntityListItem[] = [];
  for (const e of rows as any[]) {
    const entityId = String(e.id);
    const entityValues = valuesByEntity[entityId] ?? {};
    const displayValue = labelDefId ? entityValues[labelDefId] : null;
    const displayName = displayValue != null && displayValue !== '' ? String(displayValue) : undefined;
    const searchText = Object.values(entityValues)
      .map((value) => valueToSearchText(value))
      .filter(Boolean)
      .join(' ')
      .trim();
    const priceValue = priceDefId != null ? entityValues[priceDefId] : undefined;
    const price = priceValue != null ? Number(priceValue) : undefined;

    out.push({
      id: entityId,
      typeId: String(e.typeId),
      updatedAt: Number(e.updatedAt),
      syncStatus: String(e.syncStatus),
      ...(displayName != null ? { displayName } : {}),
      ...(searchText ? { searchText } : {}),
      ...(price != null && Number.isFinite(price) ? { price } : {}),
    });
  }
  // newest first
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createEntity(db: BetterSQLite3Database, entityTypeId: string) {
  const ts = nowMs();
  const id = randomUUID();
  await db.insert(entities).values({
    id,
    typeId: entityTypeId,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
  return { ok: true as const, id };
}

/**
 * Все сущности типа сразу вместе с атрибутами (ключ — код атрибута).
 *
 * Замена циклу «список + `getEntityDetails` на каждую строку»: тот делает по одному IPC-вызову
 * и ~1+N запросов на КАЖДУЮ сущность (на проде 368 услуг → 368 round-trip'ов при открытии каждой
 * карточки наряда, main-процесс синхронный и на это время встаёт). Здесь — два запроса на всё.
 */
export async function listEntitiesByTypeWithAttrs(
  db: BetterSQLite3Database,
  entityTypeId: string,
): Promise<Array<{ id: string; updatedAt: number; attributes: Record<string, unknown> }>> {
  const rows = await db
    .select({ id: entities.id, updatedAt: entities.updatedAt })
    .from(entities)
    .where(and(eq(entities.typeId, entityTypeId), isNull(entities.deletedAt)))
    .limit(5000);
  if (rows.length === 0) return [];

  const { defs } = await getDefsByType(db, entityTypeId);
  const codeByDefId = new Map(defs.map((d) => [String(d.id), String(d.code)]));
  const entityIds = rows.map((row) => String(row.id));

  const valueRows =
    codeByDefId.size > 0
      ? await db
          .select({
            entityId: attributeValues.entityId,
            attributeDefId: attributeValues.attributeDefId,
            valueJson: attributeValues.valueJson,
          })
          .from(attributeValues)
          .where(
            and(
              inArray(attributeValues.entityId, entityIds),
              inArray(attributeValues.attributeDefId, [...codeByDefId.keys()]),
              isNull(attributeValues.deletedAt),
            ),
          )
          // Oldest→newest so the per-(entity,def) map keeps the NEWEST value if stray
          // duplicate rows exist (defensive; setEntityAttribute now collapses them).
          .orderBy(asc(attributeValues.updatedAt))
          .limit(200_000)
      : [];

  const byId = new Map(
    rows.map((row) => [
      String(row.id),
      { id: String(row.id), updatedAt: Number(row.updatedAt), attributes: {} as Record<string, unknown> },
    ]),
  );
  for (const value of valueRows) {
    const target = byId.get(String(value.entityId));
    const code = codeByDefId.get(String(value.attributeDefId));
    if (!target || !code || !value.valueJson) continue;
    target.attributes[code] = safeJsonParse(String(value.valueJson));
  }
  return [...byId.values()];
}

export async function getEntityDetails(db: BetterSQLite3Database, id: string, fallbackTypeId?: string): Promise<EntityDetails> {
  const e = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  if (!e[0]) {
    // Deferred create (Phase 2): no row yet for a freshly-created, not-yet-saved card —
    // synthesize an empty card so it opens; the row is materialized on the first attribute
    // write. Only callers that pass a fallbackTypeId opt in; others keep the strict throw.
    if (fallbackTypeId) {
      const ts = nowMs();
      return { id, typeId: fallbackTypeId, createdAt: ts, updatedAt: ts, deletedAt: null, syncStatus: 'pending', attributes: {} };
    }
    throw new Error('Сущность не найдена');
  }

  const { byCode } = await getDefsByType(db, e[0].typeId);
  const attrs: Record<string, unknown> = {};
  for (const [code, defId] of Object.entries(byCode)) {
    const v = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.entityId, id), eq(attributeValues.attributeDefId, defId)))
      .limit(1);
    if (v[0]?.valueJson) attrs[code] = safeJsonParse(String(v[0].valueJson));
  }

  return {
    id: e[0].id,
    typeId: e[0].typeId,
    createdAt: e[0].createdAt,
    updatedAt: e[0].updatedAt,
    deletedAt: e[0].deletedAt ?? null,
    syncStatus: e[0].syncStatus,
    attributes: attrs,
  };
}

export async function setEntityAttribute(
  db: BetterSQLite3Database,
  entityId: string,
  code: string,
  value: unknown,
  fallbackTypeId?: string,
) {
  try {
    // Ф2: резерв двигателя server-managed. Гейт в engineService закрывает карточку
    // двигателя, но общий путь мастер-данных идёт сюда — без дубля строка ушла бы
    // в pending и вечно отбивалась server-managed backstop'ом на сервере.
    if (code === ENGINE_RESERVATION_CODE) {
      return { ok: false as const, error: 'Резерв меняется кнопками «Взять в работу» / «Вернуть», а не правкой карточки' };
    }
    const ts = nowMs();
    const e = await db.select().from(entities).where(eq(entities.id, entityId)).limit(1);
    let typeId: string;
    if (!e[0]) {
      // Deferred create (Phase 2): materialize the entity row on the first attribute write.
      // Without an opt-in fallbackTypeId we keep the strict "not found" behavior.
      if (!fallbackTypeId) return { ok: false as const, error: 'Сущность не найдена' };
      await db.insert(entities).values({
        id: entityId,
        typeId: fallbackTypeId,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      });
      typeId = fallbackTypeId;
    } else {
      typeId = e[0].typeId;
    }

    const { defs, byCode } = await getDefsByType(db, typeId);
    const defId = byCode[code];
    if (!defId) return { ok: false as const, error: `Неизвестный атрибут: ${code}` };

    const currentValue = await db
      .select({ valueJson: attributeValues.valueJson })
      .from(attributeValues)
      .where(
        and(
          eq(attributeValues.entityId, entityId),
          eq(attributeValues.attributeDefId, defId),
          isNull(attributeValues.deletedAt),
        ),
      )
      .orderBy(desc(attributeValues.updatedAt))
      .limit(1);
    const nextValueJson = JSON.stringify(value ?? null);
    if (String(currentValue[0]?.valueJson ?? '') !== nextValueJson) {
      const def = defs.find((candidate) => String(candidate.id) === defId);
      if (def) {
        const referenceError = await validateLinkValue(db, def, value);
        if (referenceError) return { ok: false as const, error: referenceError };
      }
    }

    // Pick the NEWEST non-deleted row for this (entity, attr). The old code matched by
    // (entity, attr) without a deletedAt filter or ordering and took limit(1) — with
    // duplicate or soft-deleted rows it could update an arbitrary or already-deleted row,
    // leaving the value that lists read (they pick a non-deleted row) stale. Update the
    // newest active row and soft-delete any other active duplicates so exactly one remains.
    const active = await db
      .select()
      .from(attributeValues)
      .where(
        and(
          eq(attributeValues.entityId, entityId),
          eq(attributeValues.attributeDefId, defId),
          isNull(attributeValues.deletedAt),
        ),
      )
      .orderBy(desc(attributeValues.updatedAt));

    const payload = JSON.stringify(value);
    if (active[0]) {
      await db
        .update(attributeValues)
        .set({ valueJson: payload, updatedAt: ts, syncStatus: 'pending' })
        .where(eq(attributeValues.id, active[0].id));
      for (const dup of active.slice(1)) {
        await db
          .update(attributeValues)
          .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' })
          .where(eq(attributeValues.id, dup.id));
      }
    } else {
      await db.insert(attributeValues).values({
        id: randomUUID(),
        entityId,
        attributeDefId: defId,
        valueJson: payload,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      });
    }

    await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, entityId));
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function softDeleteEntity(db: BetterSQLite3Database, entityId: string) {
  try {
    const ts = nowMs();
    await db.update(entities).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, entityId));
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

type IncomingLinkRow = {
  valueId: string;
  fromEntityId: string;
  fromEntityTypeId: string;
  fromEntityTypeCode: string;
  fromEntityTypeName: string;
  attributeDefId: string;
  attributeCode: string;
  attributeName: string;
};

export type IncomingLinkInfo = Omit<IncomingLinkRow, 'valueId'> & { fromEntityDisplayName: string | null };

async function getEntityDisplayName(db: BetterSQLite3Database, entityId: string, entityTypeId: string): Promise<string | null> {
  const { byCode } = await getDefsByType(db, entityTypeId);
  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;
  if (!labelDefId) return null;

  const v = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, entityId), eq(attributeValues.attributeDefId, labelDefId)))
    .limit(1);

  const val = v[0]?.valueJson ? safeJsonParse(String(v[0].valueJson)) : null;
  if (val == null || val === '') return null;
  return String(val);
}

async function findIncomingLinkRows(db: BetterSQLite3Database, entityId: string): Promise<IncomingLinkRow[]> {
  const target = JSON.stringify(entityId);
  const rows = await db
    .select({
      valueId: attributeValues.id,
      fromEntityId: attributeValues.entityId,
      attributeDefId: attributeDefs.id,
      attributeCode: attributeDefs.code,
      attributeName: attributeDefs.name,
      fromEntityTypeId: entities.typeId,
      fromEntityTypeCode: entityTypes.code,
      fromEntityTypeName: entityTypes.name,
    })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeValues.attributeDefId, attributeDefs.id))
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .innerJoin(entityTypes, eq(entities.typeId, entityTypes.id))
    .where(
      and(
        isNull(attributeValues.deletedAt),
        eq(attributeValues.valueJson, target),
        isNull(attributeDefs.deletedAt),
        eq(attributeDefs.dataType, 'link'),
        isNull(entities.deletedAt),
        isNull(entityTypes.deletedAt),
      ),
    )
    .limit(10_000);

  return rows.map((r) => ({
    valueId: String(r.valueId),
    fromEntityId: String(r.fromEntityId),
    fromEntityTypeId: String(r.fromEntityTypeId),
    fromEntityTypeCode: String(r.fromEntityTypeCode),
    fromEntityTypeName: String(r.fromEntityTypeName),
    attributeDefId: String(r.attributeDefId),
    attributeCode: String(r.attributeCode),
    attributeName: String(r.attributeName),
  }));
}

export async function getIncomingLinksForEntity(db: BetterSQLite3Database, entityId: string): Promise<{ ok: true; links: IncomingLinkInfo[] } | { ok: false; error: string }> {
  try {
    const rows = await findIncomingLinkRows(db, entityId);
    const cache = new Map<string, string | null>();
    const out: IncomingLinkInfo[] = [];

    for (const r of rows) {
      const { valueId: _valueId, ...rest } = r;
      const key = `${r.fromEntityTypeId}:${r.fromEntityId}`;
      let display = cache.get(key) ?? null;
      if (!cache.has(key)) {
        display = await getEntityDisplayName(db, r.fromEntityId, r.fromEntityTypeId);
        cache.set(key, display);
      }
      out.push({ ...rest, fromEntityDisplayName: display });
    }

    // Сортируем для стабильного UI.
    const cleaned = out.sort((a, b) => {
      const t = a.fromEntityTypeName.localeCompare(b.fromEntityTypeName, 'ru');
      if (t !== 0) return t;
      const da = (a.fromEntityDisplayName ?? '').toLowerCase();
      const dbb = (b.fromEntityDisplayName ?? '').toLowerCase();
      if (da !== dbb) return da.localeCompare(dbb, 'ru');
      return a.fromEntityId.localeCompare(b.fromEntityId);
    });

    return { ok: true, links: cleaned };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function shortId(id: string): string {
  return `#${String(id).slice(0, 8)}`;
}

/**
 * Полный реверс-индекс входящих ссылок на сущность — по ВСЕМ хранилищам, а не только
 * link-типизированным EAV (что видит findIncomingLinkRows). Закрывает дыры: массивные
 * EAV-линки, contract_sections JSON, meta_json нарядов/заявок, junction BOM. Основа Ф1
 * диалога намерения при удалении. Только чтение локальной реплики.
 */
export async function findAllIncomingReferences(
  db: BetterSQLite3Database,
  entityId: string,
): Promise<{ ok: true; groups: IncomingReferenceGroup[] } | { ok: false; error: string }> {
  try {
    const groups: IncomingReferenceGroup[] = [];
    const jsonId = JSON.stringify(entityId);

    // 1. EAV-линки: одиночные (value_json === "id") и массивные (value_json содержит "id").
    const linkRows = await db
      .select({
        fromEntityId: attributeValues.entityId,
        valueJson: attributeValues.valueJson,
        attributeName: attributeDefs.name,
        fromEntityTypeId: entities.typeId,
        fromEntityTypeName: entityTypes.name,
      })
      .from(attributeValues)
      .innerJoin(attributeDefs, eq(attributeValues.attributeDefId, attributeDefs.id))
      .innerJoin(entities, eq(attributeValues.entityId, entities.id))
      .innerJoin(entityTypes, eq(entities.typeId, entityTypes.id))
      .where(
        and(
          isNull(attributeValues.deletedAt),
          eq(attributeDefs.dataType, 'link'),
          isNull(attributeDefs.deletedAt),
          isNull(entities.deletedAt),
          isNull(entityTypes.deletedAt),
          or(eq(attributeValues.valueJson, jsonId), like(attributeValues.valueJson, `%${jsonId}%`)),
        ),
      )
      .limit(10_000);
    const linkByEntity = new Map<string, { typeId: string; typeName: string; paths: string[] }>();
    for (const r of linkRows) {
      const parsed = r.valueJson ? safeJsonParse(String(r.valueJson)) : null;
      const hit = Array.isArray(parsed) ? parsed.map(String).includes(entityId) : String(parsed ?? '') === entityId;
      if (!hit) continue; // LIKE мог зацепить подстроку — сверяем разбором
      const key = String(r.fromEntityId);
      const entry = linkByEntity.get(key) ?? { typeId: String(r.fromEntityTypeId), typeName: String(r.fromEntityTypeName), paths: [] };
      entry.paths.push(String(r.attributeName));
      linkByEntity.set(key, entry);
    }
    for (const [fromEntityId, entry] of linkByEntity) {
      const display = await getEntityDisplayName(db, fromEntityId, entry.typeId);
      groups.push({
        sourceKind: 'eav_link',
        sourceId: fromEntityId,
        sourceLabel: display ?? shortId(fromEntityId),
        sourceTypeLabel: entry.typeName,
        paths: entry.paths,
      });
    }

    // 2. Контракты (contract_sections JSON).
    const contractDefs = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.code, 'contract_sections'), isNull(attributeDefs.deletedAt)));
    const contractDefIds = contractDefs.map((d) => String(d.id));
    if (contractDefIds.length > 0) {
      const contractRows = await db
        .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
        .from(attributeValues)
        .innerJoin(entities, eq(attributeValues.entityId, entities.id))
        .where(
          and(
            inArray(attributeValues.attributeDefId, contractDefIds),
            isNull(attributeValues.deletedAt),
            isNull(entities.deletedAt),
            like(attributeValues.valueJson, `%${jsonId}%`),
          ),
        )
        .limit(10_000);
      for (const r of contractRows) {
        const sections = r.valueJson ? (safeJsonParse(String(r.valueJson)) as Record<string, any> | null) : null;
        if (!sections) continue;
        const paths = collectContractEntityReferences(sections)
          .filter((c) => c.referenceId === entityId)
          .map((c) => c.path);
        if (paths.length === 0) continue;
        const num = String(sections.primary?.internalNumber ?? sections.primary?.number ?? '').trim();
        groups.push({
          sourceKind: 'contract',
          sourceId: String(r.entityId),
          sourceLabel: num || shortId(String(r.entityId)),
          sourceTypeLabel: 'Контракт',
          paths,
        });
      }
    }

    // 3. Наряды + заявки (operations.meta_json). Ограничиваемся этими типами — акты
    //    дефектовки (тяжёлые блобы) сюда не попадают.
    const opRows = await db
      .select({ id: operations.id, operationType: operations.operationType, metaJson: operations.metaJson })
      .from(operations)
      .where(
        and(
          inArray(operations.operationType, ['work_order', 'supply_request']),
          isNull(operations.deletedAt),
          like(operations.metaJson, `%${jsonId}%`),
        ),
      )
      .limit(10_000);
    for (const r of opRows) {
      const meta = r.metaJson ? (safeJsonParse(String(r.metaJson)) as Record<string, any> | null) : null;
      if (!meta) continue;
      const isWorkOrder = String(r.operationType) === 'work_order';
      const paths = (isWorkOrder ? collectWorkOrderEntityReferences(meta) : collectSupplyRequestEntityReferences(meta))
        .filter((c) => c.referenceId === entityId)
        .map((c) => c.path);
      if (paths.length === 0) continue;
      const num = String(meta.number ?? meta.orderNumber ?? meta.requestNumber ?? '').trim();
      groups.push({
        sourceKind: isWorkOrder ? 'work_order' : 'supply_request',
        sourceId: String(r.id),
        sourceLabel: num || shortId(String(r.id)),
        sourceTypeLabel: isWorkOrder ? 'Наряд' : 'Заявка снабжения',
        paths,
      });
    }

    // 4. BOM: junction erp_engine_assembly_bom_brand_links.engine_brand_id.
    const bomRows = await db
      .select({ id: erpEngineAssemblyBomBrandLinks.id, bomId: erpEngineAssemblyBomBrandLinks.bomId })
      .from(erpEngineAssemblyBomBrandLinks)
      .where(and(eq(erpEngineAssemblyBomBrandLinks.engineBrandId, entityId), isNull(erpEngineAssemblyBomBrandLinks.deletedAt)))
      .limit(10_000);
    for (const r of bomRows) {
      groups.push({
        sourceKind: 'bom',
        sourceId: String(r.id),
        sourceLabel: shortId(String(r.bomId)),
        sourceTypeLabel: 'Спецификация BOM',
        paths: ['engine_brand_id'],
      });
    }

    groups.sort((a, b) => a.sourceTypeLabel.localeCompare(b.sourceTypeLabel, 'ru') || a.sourceLabel.localeCompare(b.sourceLabel, 'ru'));
    return { ok: true, groups };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function normalizeLookupText(raw: string): string {
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/\s+/g, ' ');
}

function scoreLookupMatch(normalizedQuery: string, normalizedTarget: string): number {
  if (!normalizedQuery || !normalizedTarget) return 0;
  if (normalizedQuery === normalizedTarget) return 1000;
  if (normalizedTarget.startsWith(normalizedQuery)) return 700 + Math.round((normalizedQuery.length / Math.max(1, normalizedTarget.length)) * 300);
  if (normalizedTarget.includes(normalizedQuery)) return 500 + Math.round((normalizedQuery.length / Math.max(1, normalizedTarget.length)) * 200);
  let qi = 0;
  let matched = 0;
  for (let ti = 0; ti < normalizedTarget.length && qi < normalizedQuery.length; ti++) {
    if (normalizedQuery[qi] === normalizedTarget[ti]) { matched++; qi++; }
  }
  if (qi === 0) return 0;
  const coverage = matched / normalizedQuery.length;
  if (coverage >= 0.6) return Math.round(200 + coverage * 160);
  return 0;
}

export type DuplicateCandidate = {
  id: string;
  displayName: string;
  score: number;
  attributes: Record<string, unknown>;
};

export async function findDuplicateEntities(
  db: BetterSQLite3Database,
  entityTypeId: string,
  query: { name?: string; article?: string; inn?: string; price?: number },
  excludeEntityId?: string,
): Promise<DuplicateCandidate[]> {
  const name = (query.name ?? '').trim();
  const article = (query.article ?? '').trim();
  const inn = (query.inn ?? '').trim();
  const price = query.price;

  if (!name && !article && !inn) return [];

  const { byCode } = await getDefsByType(db, entityTypeId);
  const nameDefId = byCode['name'] ?? null;
  const articleDefId = byCode['article'] ?? null;
  const innDefId = byCode['inn'] ?? null;
  const priceDefId = byCode['price'] ?? null;

  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;

  const relevantDefIds = [nameDefId, articleDefId, innDefId, priceDefId].filter(Boolean) as string[];
  if (relevantDefIds.length === 0) return [];

  const allEntities = await db
    .select()
    .from(entities)
    .where(and(eq(entities.typeId, entityTypeId), isNull(entities.deletedAt)))
    .limit(5000);

  if (allEntities.length === 0) return [];

  const targetEntityIds = allEntities.map((e) => String(e.id)).filter((id) => id !== excludeEntityId);
  if (targetEntityIds.length === 0) return [];

  const valueRows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, targetEntityIds as any),
        inArray(attributeValues.attributeDefId, relevantDefIds as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(50_000);

  const valuesByEntity: Record<string, Record<string, unknown>> = {};
  for (const row of valueRows as any[]) {
    const entityId = String(row.entityId);
    const defId = String(row.attributeDefId);
    if (!valuesByEntity[entityId]) valuesByEntity[entityId] = {};
    valuesByEntity[entityId][defId] = row.valueJson ? safeJsonParse(String(row.valueJson)) : null;
  }

  const normalizedQueryName = normalizeLookupText(name);
  const normalizedQueryArticle = normalizeLookupText(article);
  const normalizedQueryInn = normalizeLookupText(inn);

  const candidates: DuplicateCandidate[] = [];

  for (const e of allEntities) {
    const entityId = String(e.id);
    if (entityId === excludeEntityId) continue;

    const entityValues = valuesByEntity[entityId] ?? {};
    const labelDef = labelDefId != null ? entityValues[labelDefId] : null;
    const displayName = labelDef != null && labelDef !== '' ? String(labelDef) : '(без названия)';

    let score = 0;

    if (nameDefId && entityValues[nameDefId] != null) {
      const existingName = normalizeLookupText(String(entityValues[nameDefId]));
      const nameScore = scoreLookupMatch(normalizedQueryName, existingName);
      if (nameScore > 0) score = Math.max(score, nameScore);
    }

    if (articleDefId && article && entityValues[articleDefId] != null) {
      const existingArticle = normalizeLookupText(String(entityValues[articleDefId]));
      const articleScore = scoreLookupMatch(normalizedQueryArticle, existingArticle);
      if (articleScore > 0) score = Math.max(score, Math.round((score + articleScore) / 2));
      else if (score > 0) score = Math.round(score * 0.85);
    }

    if (innDefId && inn && entityValues[innDefId] != null) {
      const existingInn = normalizeLookupText(String(entityValues[innDefId]));
      if (existingInn === normalizedQueryInn) score = 1000;
      else if (score > 0) score = Math.round(score * 0.85);
    }

    if (priceDefId && price != null && entityValues[priceDefId] != null) {
      const existingPrice = Number(entityValues[priceDefId]);
      if (Number.isFinite(existingPrice) && Math.abs(existingPrice - price) < 0.01 && score > 0) {
        score = Math.min(1000, score + 50);
      }
    }

    if (score >= 300) {
      const attrs: Record<string, unknown> = {};
      if (nameDefId && entityValues[nameDefId] != null) attrs.name = entityValues[nameDefId];
      if (articleDefId && entityValues[articleDefId] != null) attrs.article = entityValues[articleDefId];
      if (innDefId && entityValues[innDefId] != null) attrs.inn = entityValues[innDefId];
      if (priceDefId && entityValues[priceDefId] != null) attrs.price = entityValues[priceDefId];

      candidates.push({ id: entityId, displayName, score, attributes: attrs });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 10);
}

export async function detachIncomingLinksAndSoftDeleteEntity(db: BetterSQLite3Database, entityId: string): Promise<{ ok: true; detached: number } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const rows = await findIncomingLinkRows(db, entityId);

    for (const r of rows) {
      await db
        .update(attributeValues)
        .set({ valueJson: JSON.stringify(null), updatedAt: ts, syncStatus: 'pending' })
        .where(eq(attributeValues.id, r.valueId));
      await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, r.fromEntityId));
    }

    const del = await softDeleteEntity(db, entityId);
    if (!del.ok) return { ok: false, error: del.error ?? 'delete failed' };
    return { ok: true, detached: rows.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}



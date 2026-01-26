import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, changeLog, entities, entityTypes } from '../database/schema.js';

type EntityRow = {
  id: string;
  typeId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
};

type AttrDefRow = {
  id: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  sortOrder: number;
  metaJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
};

type AttrValueRow = {
  id: string;
  entityId: string;
  attributeDefId: string;
  valueJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
};

function nowMs() {
  return Date.now();
}

function normalizeName(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function normalizeInn(s: string): string {
  return String(s || '').replaceAll(/\D+/g, '').trim();
}

function safeJsonParse(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function entityPayload(row: EntityRow) {
  return {
    id: String(row.id),
    type_id: String(row.typeId),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function attributeDefPayload(row: AttrDefRow) {
  return {
    id: String(row.id),
    entity_type_id: String(row.entityTypeId),
    code: String(row.code),
    name: String(row.name),
    data_type: String(row.dataType),
    is_required: false,
    sort_order: Number(row.sortOrder ?? 0),
    meta_json: row.metaJson == null ? null : String(row.metaJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function attributeValuePayload(row: AttrValueRow) {
  return {
    id: String(row.id),
    entity_id: String(row.entityId),
    attribute_def_id: String(row.attributeDefId),
    value_json: row.valueJson == null ? null : String(row.valueJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

async function insertChangeLog(tableName: string, rowId: string, payload: unknown, op: 'upsert' | 'delete' = 'upsert') {
  await db.insert(changeLog).values({
    tableName,
    rowId: rowId as any,
    op,
    payloadJson: JSON.stringify(payload),
    createdAt: nowMs(),
  });
}

async function ensureCustomerDef(
  customerTypeId: string,
  code: string,
  name: string,
  dataType: string,
  sortOrder: number,
  metaJson?: string | null,
): Promise<string> {
  const existing = await db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, customerTypeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existing[0]) return String(existing[0].id);

  const ts = nowMs();
  const id = randomUUID();
  await db.insert(attributeDefs).values({
    id,
    entityTypeId: customerTypeId as any,
    code,
    name,
    dataType,
    isRequired: false,
    sortOrder,
    metaJson: metaJson ?? null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  const row: AttrDefRow = {
    id,
    entityTypeId: customerTypeId,
    code,
    name,
    dataType,
    sortOrder,
    metaJson: metaJson ?? null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  };
  await insertChangeLog('attribute_defs', id, attributeDefPayload(row));
  return id;
}

async function touchEntity(entityId: string, ts: number) {
  const cur = await db.select().from(entities).where(eq(entities.id, entityId as any)).limit(1);
  const row = cur[0] as any;
  if (!row) return;
  await db.update(entities).set({ updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, entityId as any));
  const payload = entityPayload({
    id: String(row.id),
    typeId: String(row.typeId),
    createdAt: Number(row.createdAt),
    updatedAt: ts,
    deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
    syncStatus: 'synced',
  });
  await insertChangeLog('entities', String(row.id), payload);
}

async function updateAttrValue(row: AttrValueRow, next: Partial<AttrValueRow>, ts: number) {
  await db
    .update(attributeValues)
    .set({ ...next, updatedAt: ts, syncStatus: 'synced' })
    .where(eq(attributeValues.id, row.id as any));
  const payload = attributeValuePayload({
    ...row,
    ...next,
    updatedAt: ts,
    syncStatus: 'synced',
  } as AttrValueRow);
  await insertChangeLog('attribute_values', String(row.id), payload);
}

async function insertAttrValue(entityId: string, defId: string, valueJson: string | null, ts: number) {
  const id = randomUUID();
  await db.insert(attributeValues).values({
    id,
    entityId: entityId as any,
    attributeDefId: defId as any,
    valueJson,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  const payload = attributeValuePayload({
    id,
    entityId,
    attributeDefId: defId,
    valueJson,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await insertChangeLog('attribute_values', id, payload);
}

async function mergeCounterparties(): Promise<{ ok: true; merged: number; converted: number } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const types = await db.select().from(entityTypes).where(isNull(entityTypes.deletedAt)).limit(5000);
    const customerType = types.find((t) => String(t.code) === 'customer') ?? null;
    const storeType = types.find((t) => String(t.code) === 'store') ?? null;
    if (!customerType?.id) return { ok: false, error: 'customer entity_type not found' };

    const customerTypeId = String(customerType.id);
    const storeTypeId = storeType?.id ? String(storeType.id) : null;

    // Ensure customer has store-like fields.
    await ensureCustomerDef(customerTypeId, 'address', 'Адрес', 'text', 40);
    await ensureCustomerDef(customerTypeId, 'phone', 'Телефон', 'text', 50);
    await ensureCustomerDef(customerTypeId, 'email', 'Email', 'text', 60);

    const defs = await db.select().from(attributeDefs).where(isNull(attributeDefs.deletedAt)).limit(50_000);
    const customerDefs = defs.filter((d) => String(d.entityTypeId) === customerTypeId);
    const storeDefs = storeTypeId ? defs.filter((d) => String(d.entityTypeId) === storeTypeId) : [];
    const customerDefByCode = new Map(customerDefs.map((d) => [String(d.code), String(d.id)]));
    const storeDefById = new Map(storeDefs.map((d) => [String(d.id), d]));

    let converted = 0;

    if (storeTypeId) {
      const storeEntities = await db
        .select()
        .from(entities)
        .where(and(eq(entities.typeId, storeTypeId as any), isNull(entities.deletedAt)))
        .limit(50_000);

      if (storeEntities.length > 0) {
        const storeIds = storeEntities.map((e) => String(e.id));
        const storeValues = await db
          .select()
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, storeIds as any), isNull(attributeValues.deletedAt)))
          .limit(200_000);

        const valuesByEntity = new Map<string, AttrValueRow[]>();
        for (const v of storeValues as any[]) {
          const entityId = String(v.entityId);
          const arr = valuesByEntity.get(entityId) ?? [];
          arr.push({
            id: String(v.id),
            entityId,
            attributeDefId: String(v.attributeDefId),
            valueJson: v.valueJson == null ? null : String(v.valueJson),
            createdAt: Number(v.createdAt),
            updatedAt: Number(v.updatedAt),
            deletedAt: v.deletedAt == null ? null : Number(v.deletedAt),
            syncStatus: String(v.syncStatus ?? 'synced'),
          });
          valuesByEntity.set(entityId, arr);
        }

        for (const e of storeEntities as any[]) {
          const entityId = String(e.id);
          await db
            .update(entities)
            .set({ typeId: customerTypeId as any, updatedAt: ts, syncStatus: 'synced' })
            .where(eq(entities.id, entityId as any));
          await insertChangeLog(
            'entities',
            entityId,
            entityPayload({
              id: entityId,
              typeId: customerTypeId,
              createdAt: Number(e.createdAt),
              updatedAt: ts,
              deletedAt: e.deletedAt == null ? null : Number(e.deletedAt),
              syncStatus: 'synced',
            }),
          );
          converted += 1;

          const rows = valuesByEntity.get(entityId) ?? [];
          for (const row of rows) {
            const storeDef = storeDefById.get(String(row.attributeDefId));
            if (!storeDef) continue;
            const code = String(storeDef.code);
            let targetDefId = customerDefByCode.get(code) ?? null;
            if (!targetDefId) {
              targetDefId = await ensureCustomerDef(
                customerTypeId,
                code,
                String(storeDef.name),
                String(storeDef.dataType),
                Number(storeDef.sortOrder ?? 0) || 0,
                storeDef.metaJson ? String(storeDef.metaJson) : null,
              );
              customerDefByCode.set(code, targetDefId);
            }
            if (targetDefId && targetDefId !== row.attributeDefId) {
              await updateAttrValue(row, { attributeDefId: targetDefId }, ts);
            }
          }
        }
      }
    }

    // Load all current customer entities after conversion.
    const customerEntities = await db
      .select()
      .from(entities)
      .where(and(eq(entities.typeId, customerTypeId as any), isNull(entities.deletedAt)))
      .limit(100_000);

    if (customerEntities.length === 0) return { ok: true, merged: 0, converted };

    const customerIds = customerEntities.map((e) => String(e.id));
    const allValues = await db
      .select()
      .from(attributeValues)
      .where(and(inArray(attributeValues.entityId, customerIds as any), isNull(attributeValues.deletedAt)))
      .limit(500_000);

    const valuesByEntity = new Map<string, AttrValueRow[]>();
    for (const v of allValues as any[]) {
      const entityId = String(v.entityId);
      const arr = valuesByEntity.get(entityId) ?? [];
      arr.push({
        id: String(v.id),
        entityId,
        attributeDefId: String(v.attributeDefId),
        valueJson: v.valueJson == null ? null : String(v.valueJson),
        createdAt: Number(v.createdAt),
        updatedAt: Number(v.updatedAt),
        deletedAt: v.deletedAt == null ? null : Number(v.deletedAt),
        syncStatus: String(v.syncStatus ?? 'synced'),
      });
      valuesByEntity.set(entityId, arr);
    }

    const defIdByCode = new Map(customerDefs.map((d) => [String(d.code), String(d.id)]));
    const innDefId = defIdByCode.get('inn') ?? null;
    const nameDefId = defIdByCode.get('name') ?? null;

    const entityMeta = new Map<string, { inn: string; name: string; createdAt: number }>();
    for (const e of customerEntities as any[]) {
      const entityId = String(e.id);
      const rows = valuesByEntity.get(entityId) ?? [];
      let name = '';
      let inn = '';
      for (const r of rows) {
        if (nameDefId && r.attributeDefId === nameDefId) {
          const v = safeJsonParse(r.valueJson);
          name = typeof v === 'string' ? v : v == null ? '' : String(v);
        }
        if (innDefId && r.attributeDefId === innDefId) {
          const v = safeJsonParse(r.valueJson);
          inn = typeof v === 'string' ? v : v == null ? '' : String(v);
        }
      }
      entityMeta.set(entityId, { inn: normalizeInn(inn), name: normalizeName(name), createdAt: Number(e.createdAt) });
    }

    const linkDefIds = defs.filter((d) => String(d.dataType) === 'link' && d.deletedAt == null).map((d) => String(d.id));

    function pickTarget(ids: string[]): string {
      return [...ids].sort((a, b) => {
        const ta = entityMeta.get(a)?.createdAt ?? 0;
        const tb = entityMeta.get(b)?.createdAt ?? 0;
        if (ta !== tb) return ta - tb;
        return a.localeCompare(b);
      })[0];
    }

    async function mergeInto(targetId: string, sourceId: string): Promise<void> {
      const sourceValues = valuesByEntity.get(sourceId) ?? [];
      const targetValues = valuesByEntity.get(targetId) ?? [];
      const targetByDef = new Map(targetValues.map((v) => [v.attributeDefId, v]));

      for (const row of sourceValues) {
        const targetRow = targetByDef.get(row.attributeDefId) ?? null;
        const sourceVal = safeJsonParse(row.valueJson);
        if (!targetRow) {
          await insertAttrValue(targetId, row.attributeDefId, row.valueJson, ts);
          continue;
        }
        const targetVal = safeJsonParse(targetRow.valueJson);
        if (isEmptyValue(targetVal) && !isEmptyValue(sourceVal)) {
          await updateAttrValue(targetRow, { valueJson: row.valueJson }, ts);
        }
      }

      // Repoint link fields referencing sourceId.
      if (linkDefIds.length > 0) {
        const incoming = await db
          .select()
          .from(attributeValues)
          .where(
            and(
              inArray(attributeValues.attributeDefId, linkDefIds as any),
              eq(attributeValues.valueJson, JSON.stringify(sourceId)),
              isNull(attributeValues.deletedAt),
            ),
          )
          .limit(200_000);
        for (const row of incoming as any[]) {
          const current: AttrValueRow = {
            id: String(row.id),
            entityId: String(row.entityId),
            attributeDefId: String(row.attributeDefId),
            valueJson: row.valueJson == null ? null : String(row.valueJson),
            createdAt: Number(row.createdAt),
            updatedAt: Number(row.updatedAt),
            deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
            syncStatus: String(row.syncStatus ?? 'synced'),
          };
          await updateAttrValue(current, { valueJson: JSON.stringify(targetId) }, ts);
          await touchEntity(current.entityId, ts);
        }
      }

      // Soft delete source entity.
      await db.update(entities).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, sourceId as any));
      await insertChangeLog(
        'entities',
        sourceId,
        entityPayload({
          id: sourceId,
          typeId: customerTypeId,
          createdAt: Number((customerEntities as any[]).find((e) => String(e.id) === sourceId)?.createdAt ?? ts),
          updatedAt: ts,
          deletedAt: ts,
          syncStatus: 'synced',
        }),
        'delete',
      );
    }

    let merged = 0;
    const handled = new Set<string>();

    // Pass 1: dedupe by INN.
    const byInn = new Map<string, string[]>();
    for (const id of customerIds) {
      const inn = entityMeta.get(id)?.inn ?? '';
      if (!inn) continue;
      const arr = byInn.get(inn) ?? [];
      arr.push(id);
      byInn.set(inn, arr);
    }
    for (const [inn, ids] of byInn.entries()) {
      if (ids.length < 2) continue;
      const target = pickTarget(ids);
      for (const id of ids) {
        if (id === target) continue;
        await mergeInto(target, id);
        handled.add(id);
        merged += 1;
      }
    }

    // Pass 2: dedupe by normalized name for remaining items without INN.
    const byName = new Map<string, string[]>();
    for (const id of customerIds) {
      if (handled.has(id)) continue;
      const meta = entityMeta.get(id);
      if (!meta) continue;
      if (meta.inn) continue;
      if (!meta.name) continue;
      const arr = byName.get(meta.name) ?? [];
      arr.push(id);
      byName.set(meta.name, arr);
    }
    for (const [name, ids] of byName.entries()) {
      if (ids.length < 2) continue;
      const target = pickTarget(ids);
      for (const id of ids) {
        if (id === target) continue;
        await mergeInto(target, id);
        merged += 1;
      }
    }

    return { ok: true, merged, converted };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function main() {
  const r = await mergeCounterparties();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(r));
  if (!r.ok) process.exit(1);
}

void main();

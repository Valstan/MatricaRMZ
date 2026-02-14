import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, pool } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  erpContracts,
  erpCounterparties,
  erpEmployeeCards,
  erpPartCards,
  erpPartTemplates,
  erpToolCards,
  erpToolTemplates,
} from '../database/schema.js';

function nowMs() {
  return Date.now();
}

async function getTypeIdByCode(code: string): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function loadEntitiesWithAttrs(typeId: string) {
  const ent = await db
    .select({ id: entities.id, createdAt: entities.createdAt, updatedAt: entities.updatedAt })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
    .limit(200_000);
  if (ent.length === 0) return [] as Array<{ id: string; createdAt: number; updatedAt: number; attrs: Record<string, unknown> }>;

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)))
    .limit(20_000);
  const defCodeById = new Map(defs.map((d) => [String(d.id), String(d.code)]));
  const entIds = ent.map((e) => String(e.id));
  const vals = await db
    .select({ entityId: attributeValues.entityId, defId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, entIds as any), isNull(attributeValues.deletedAt)))
    .limit(500_000);

  const attrsByEntity = new Map<string, Record<string, unknown>>();
  for (const v of vals) {
    const entityId = String(v.entityId);
    const code = defCodeById.get(String(v.defId));
    if (!code) continue;
    const current = attrsByEntity.get(entityId) ?? {};
    let parsed: unknown = null;
    try {
      parsed = v.valueJson == null ? null : JSON.parse(String(v.valueJson));
    } catch {
      parsed = v.valueJson;
    }
    current[code] = parsed;
    attrsByEntity.set(entityId, current);
  }

  return ent.map((e) => ({
    id: String(e.id),
    createdAt: Number(e.createdAt),
    updatedAt: Number(e.updatedAt),
    attrs: attrsByEntity.get(String(e.id)) ?? {},
  }));
}

async function migrateParts() {
  const partTypeId = await getTypeIdByCode('part');
  if (!partTypeId) return { templates: 0, cards: 0, source: 0 };
  const rows = await loadEntitiesWithAttrs(partTypeId);
  const ts = nowMs();
  let templates = 0;
  let cards = 0;

  for (const src of rows) {
    const code = String(src.attrs.article ?? src.attrs.part_number ?? src.id).trim();
    const name = String(src.attrs.name ?? src.attrs.full_name ?? code ?? 'Деталь').trim();
    const templateId = randomUUID();
    await db.insert(erpPartTemplates).values({
      id: templateId,
      code: code || templateId,
      name: name || code || 'Деталь',
      specJson: JSON.stringify(src.attrs),
      isActive: true,
      createdAt: src.createdAt || ts,
      updatedAt: src.updatedAt || ts,
      deletedAt: null,
    });
    templates += 1;

    await db.insert(erpPartCards).values({
      id: randomUUID(),
      templateId,
      serialNo: src.attrs.serial_no ? String(src.attrs.serial_no) : null,
      cardNo: src.attrs.card_no ? String(src.attrs.card_no) : code || null,
      attrsJson: JSON.stringify(src.attrs),
      status: 'active',
      createdAt: src.createdAt || ts,
      updatedAt: src.updatedAt || ts,
      deletedAt: null,
    });
    cards += 1;
  }
  return { templates, cards, source: rows.length };
}

async function migrateTools() {
  const typeId = await getTypeIdByCode('tool');
  if (!typeId) return { templates: 0, cards: 0, source: 0 };
  const rows = await loadEntitiesWithAttrs(typeId);
  const ts = nowMs();
  let templates = 0;
  let cards = 0;
  for (const src of rows) {
    const code = String(src.attrs.tool_number ?? src.attrs.number ?? src.id).trim();
    const name = String(src.attrs.name ?? code ?? 'Инструмент').trim();
    const templateId = randomUUID();
    await db.insert(erpToolTemplates).values({
      id: templateId,
      code: code || templateId,
      name: name || code || 'Инструмент',
      specJson: JSON.stringify(src.attrs),
      isActive: true,
      createdAt: src.createdAt || ts,
      updatedAt: src.updatedAt || ts,
      deletedAt: null,
    });
    templates += 1;
    await db.insert(erpToolCards).values({
      id: randomUUID(),
      templateId,
      serialNo: src.attrs.serial_number ? String(src.attrs.serial_number) : null,
      cardNo: src.attrs.card_no ? String(src.attrs.card_no) : code || null,
      attrsJson: JSON.stringify(src.attrs),
      status: 'active',
      createdAt: src.createdAt || ts,
      updatedAt: src.updatedAt || ts,
      deletedAt: null,
    });
    cards += 1;
  }
  return { templates, cards, source: rows.length };
}

async function migrateCounterparties() {
  const typeId = (await getTypeIdByCode('counterparty')) ?? (await getTypeIdByCode('customer'));
  if (!typeId) return { rows: 0, source: 0 };
  const rows = await loadEntitiesWithAttrs(typeId);
  const ts = nowMs();
  for (const src of rows) {
    const code = String(src.attrs.code ?? src.id).trim();
    const name = String(src.attrs.name ?? src.attrs.full_name ?? code ?? 'Контрагент').trim();
    await db.insert(erpCounterparties).values({
      id: randomUUID(),
      code: code || randomUUID(),
      name: name || 'Контрагент',
      attrsJson: JSON.stringify(src.attrs),
      isActive: true,
      createdAt: src.createdAt || ts,
      updatedAt: src.updatedAt || ts,
      deletedAt: null,
    });
  }
  return { rows: rows.length, source: rows.length };
}

async function migrateContracts() {
  const typeId = await getTypeIdByCode('contract');
  if (!typeId) return { rows: 0, source: 0 };
  const rows = await loadEntitiesWithAttrs(typeId);
  const ts = nowMs();
  for (const src of rows) {
    const code = String(src.attrs.number ?? src.attrs.code ?? src.id).trim();
    const name = String(src.attrs.name ?? src.attrs.title ?? code ?? 'Контракт').trim();
    await db.insert(erpContracts).values({
      id: randomUUID(),
      code: code || randomUUID(),
      name: name || 'Контракт',
      counterpartyId: null,
      startsAt: src.attrs.starts_at ? Number(src.attrs.starts_at) : null,
      endsAt: src.attrs.ends_at ? Number(src.attrs.ends_at) : null,
      attrsJson: JSON.stringify(src.attrs),
      isActive: true,
      createdAt: src.createdAt || ts,
      updatedAt: src.updatedAt || ts,
      deletedAt: null,
    });
  }
  return { rows: rows.length, source: rows.length };
}

async function migrateEmployees() {
  const typeId = await getTypeIdByCode('employee');
  if (!typeId) return { rows: 0, source: 0 };
  const rows = await loadEntitiesWithAttrs(typeId);
  const ts = nowMs();
  for (const src of rows) {
    const fullName = String(src.attrs.full_name ?? src.attrs.name ?? src.id).trim();
    await db.insert(erpEmployeeCards).values({
      id: randomUUID(),
      personnelNo: src.attrs.personnel_number ? String(src.attrs.personnel_number) : null,
      fullName: fullName || 'Сотрудник',
      roleCode: src.attrs.system_role ? String(src.attrs.system_role) : null,
      attrsJson: JSON.stringify(src.attrs),
      isActive: true,
      createdAt: src.createdAt || ts,
      updatedAt: src.updatedAt || ts,
      deletedAt: null,
    });
  }
  return { rows: rows.length, source: rows.length };
}

async function main() {
  const part = await migrateParts();
  const tool = await migrateTools();
  const cp = await migrateCounterparties();
  const ct = await migrateContracts();
  const emp = await migrateEmployees();

  const report = {
    migratedAt: new Date().toISOString(),
    source: {
      parts: part.source,
      tools: tool.source,
      counterparties: cp.source,
      contracts: ct.source,
      employees: emp.source,
    },
    target: {
      partTemplates: part.templates,
      partCards: part.cards,
      toolTemplates: tool.templates,
      toolCards: tool.cards,
      counterparties: cp.rows,
      contracts: ct.rows,
      employees: emp.rows,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});

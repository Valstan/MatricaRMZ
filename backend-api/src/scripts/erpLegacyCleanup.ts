import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { eq } from 'drizzle-orm';

function nowMs() {
  return Date.now();
}

async function main() {
  const apply = process.argv.includes('--apply');
  const ts = nowMs();
  const legacyTypeCodes = ['part', 'tool', 'counterparty', 'contract', 'employee'];

  const types = await db.select({ id: entityTypes.id, code: entityTypes.code }).from(entityTypes);
  const targetTypes = types.filter((t) => legacyTypeCodes.includes(String(t.code)));
  const typeIds = targetTypes.map((t) => String(t.id));
  const typeIdSet = new Set(typeIds);

  const legacyEntities = await db.select({ id: entities.id, typeId: entities.typeId }).from(entities);
  const entityIds = legacyEntities.filter((e) => typeIdSet.has(String(e.typeId))).map((e) => String(e.id));
  const defs = await db.select({ id: attributeDefs.id, entityTypeId: attributeDefs.entityTypeId }).from(attributeDefs);
  const defIds = defs.filter((d) => typeIdSet.has(String(d.entityTypeId))).map((d) => String(d.id));

  const report = {
    apply,
    typeIds: typeIds.length,
    entityIds: entityIds.length,
    defIds: defIds.length,
  };

  if (!apply) {
    console.log(JSON.stringify({ ...report, note: 'Тестовый запуск. Добавьте --apply для мягкого удаления устаревших EAV-строк.' }, null, 2));
    await pool.end();
    return;
  }

  for (const id of entityIds) {
    await db.update(entities).set({ deletedAt: ts, updatedAt: ts }).where(eq(entities.id, id as any));
  }
  for (const id of defIds) {
    await db.update(attributeDefs).set({ deletedAt: ts, updatedAt: ts }).where(eq(attributeDefs.id, id as any));
  }
  for (const id of entityIds) {
    await db.update(attributeValues).set({ deletedAt: ts, updatedAt: ts }).where(eq(attributeValues.entityId, id as any));
  }

  console.log(JSON.stringify({ ...report, deletedAt: ts, done: true }, null, 2));
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});

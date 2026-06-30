import 'dotenv/config';

import { and, eq, inArray, isNull, like, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { db, pool } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  erpNomenclature,
  erpRegStockBalance,
  warehouseLocations,
} from '../database/schema.js';

// Fixture for the verifier-electron CDP driver: a single nomenclature group with
// > 50 positions (so the NomenclaturePage load-all path from PR #126 is actually
// exercised — old code paged at 50) plus a few positions with no group (the
// «Без группы» section). Direct SQL into erp_nomenclature. Idempotent: prior
// fixture rows (by code prefix) are deleted and re-inserted, the group entity is
// reused by name.

const GROUP_NAME = 'VERIFY · Load-all (CDP)';
const GROUP_SIZE = 62; // > 50 → forces the multi-page / full-sort path
const LOADALL_CODE_PREFIX = 'VERIFY-LOADALL-';
const NOGROUP_CODE_PREFIX = 'VERIFY-NOGROUP-';
const NOGROUP_SIZE = 3;
const ITEM_TYPES = ['material', 'product', 'tool'];

function repoRoot(): string {
  // backend-api/src/scripts/ -> repo root is three levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
}

async function ensureNameAttrDef(typeId: string): Promise<string> {
  const existing = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return String(existing[0].id);
  const id = randomUUID();
  const ts = Date.now();
  await db.insert(attributeDefs).values({
    id,
    entityTypeId: typeId as any,
    code: 'name',
    name: 'Наименование',
    dataType: 'text',
    isRequired: false,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  return id;
}

const WAREHOUSE_NAME = 'VERIFY · Склад (CDP)';

// The Inventory page's warehouse picker keys options by warehouse_locations.code
// (LookupOption.id = row.code), but erp_reg_stock_balance.warehouse_location_id
// stores warehouse_locations.id. They only match when code === id. The stock
// system/workshop locations have code !== id, so selecting them in the UI yields
// zero rows. We therefore create a dedicated fixture location with code === id
// (a fresh uuid) so the seeded balances are actually loadable via the UI.
async function ensureFixtureWarehouseLocation(): Promise<{ id: string; code: string; name: string }> {
  const existing = await db
    .select({ id: warehouseLocations.id, code: warehouseLocations.code, name: warehouseLocations.name })
    .from(warehouseLocations)
    .where(and(eq(warehouseLocations.name, WAREHOUSE_NAME), isNull(warehouseLocations.deletedAt)))
    .limit(1);
  if (existing[0]?.id) {
    return { id: String(existing[0].id), code: String(existing[0].code), name: String(existing[0].name) };
  }
  const ts = Date.now();
  const id = randomUUID();
  await db.insert(warehouseLocations).values({
    id,
    type: 'regular',
    code: id, // code === id so the UI lookup (id=code) resolves to this uuid
    name: WAREHOUSE_NAME,
    workshopId: null,
    isActive: true,
    sortOrder: 999,
    metadataJson: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  });
  return { id, code: id, name: WAREHOUSE_NAME };
}

async function ensureGroupEntity(): Promise<string> {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'nomenclature_group'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : '';
  if (!typeId) {
    throw new Error('entity type nomenclature_group not found — run migrations / bootstrap first');
  }
  const nameDefId = await ensureNameAttrDef(typeId);

  // Reuse an existing group entity with this name if present.
  const existing = await db
    .select({ id: entities.id })
    .from(entities)
    .innerJoin(
      attributeValues,
      and(
        eq(attributeValues.entityId, entities.id),
        eq(attributeValues.attributeDefId, nameDefId as any),
        eq(attributeValues.valueJson, JSON.stringify(GROUP_NAME)),
        isNull(attributeValues.deletedAt),
      ),
    )
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return String(existing[0].id);

  const ts = Date.now();
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
    valueJson: JSON.stringify(GROUP_NAME),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  return entityId;
}

async function main() {
  const groupId = await ensureGroupEntity();

  // Wipe any prior fixture rows so re-runs converge to an exact state. Stock
  // balances reference erp_nomenclature, so delete them first (FK-safe order).
  const prior = await db
    .select({ id: erpNomenclature.id })
    .from(erpNomenclature)
    .where(or(like(erpNomenclature.code, `${LOADALL_CODE_PREFIX}%`), like(erpNomenclature.code, `${NOGROUP_CODE_PREFIX}%`)));
  const priorIds = prior.map((r) => String(r.id));
  if (priorIds.length) {
    await db.delete(erpRegStockBalance).where(inArray(erpRegStockBalance.nomenclatureId, priorIds));
  }
  await db.delete(erpNomenclature).where(like(erpNomenclature.code, `${LOADALL_CODE_PREFIX}%`));
  await db.delete(erpNomenclature).where(like(erpNomenclature.code, `${NOGROUP_CODE_PREFIX}%`));

  const ts = Date.now();
  const loadAllRows = Array.from({ length: GROUP_SIZE }, (_, i) => {
    const seq = i + 1;
    // Scrambled leading token so alphabetical order != insertion order: a partial
    // (first-page-only) sort would NOT produce a globally monotonic name column.
    const scramble = String((seq * 37) % 100).padStart(2, '0');
    return {
      id: randomUUID(),
      code: `${LOADALL_CODE_PREFIX}${String(seq).padStart(4, '0')}`,
      name: `Поз ${scramble}-${String(seq).padStart(3, '0')}`,
      itemType: ITEM_TYPES[i % ITEM_TYPES.length] as string,
      groupId: groupId as any,
      unitId: null,
      isActive: true,
      syncStatus: 'synced',
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
  });
  const noGroupRows = Array.from({ length: NOGROUP_SIZE }, (_, i) => {
    const seq = i + 1;
    return {
      id: randomUUID(),
      code: `${NOGROUP_CODE_PREFIX}${String(seq).padStart(3, '0')}`,
      name: `Без группы — позиция ${String(seq).padStart(3, '0')}`,
      itemType: 'material',
      groupId: null,
      unitId: null,
      isActive: true,
      syncStatus: 'synced',
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
  });

  await db.insert(erpNomenclature).values(loadAllRows);
  await db.insert(erpNomenclature).values(noGroupRows);

  // Stock balances for the fixture warehouse location, so the Inventory page has
  // a > 25-row virtualized list (needed to probe the «Факт» focus question).
  // One balance per load-all position; reuses the just-inserted nomenclature ids.
  const warehouse = await ensureFixtureWarehouseLocation();
  const balanceRows = loadAllRows.map((r, i) => ({
    id: randomUUID(),
    nomenclatureId: r.id as any,
    partCardId: null,
    warehouseLocationId: warehouse.id as any,
    qty: (i * 7) % 50 + 1,
    reservedQty: 0,
    updatedAt: ts,
  }));
  await db.insert(erpRegStockBalance).values(balanceRows);

  // Manifest for the CDP driver (decouples it from hardcoded names/counts).
  const stateDir = join(repoRoot(), '.verifier-electron');
  mkdirSync(stateDir, { recursive: true });
  const manifest = {
    groupId,
    groupName: GROUP_NAME,
    groupSize: GROUP_SIZE,
    noGroupCodes: noGroupRows.map((r) => r.code),
    loadAllCodePrefix: LOADALL_CODE_PREFIX,
    warehouseLocationId: warehouse.id,
    warehouseCode: warehouse.code,
    warehouseLabel: warehouse.name,
    stockRows: GROUP_SIZE,
    seededAt: ts,
  };
  writeFileSync(join(stateDir, 'nomenclature-verify-fixture.json'), JSON.stringify(manifest, null, 2));

  console.log('=== Nomenclature verify fixture ready ===');
  console.log(`group id:        ${groupId}`);
  console.log(`group name:      ${GROUP_NAME}`);
  console.log(`positions:       ${GROUP_SIZE} (codes ${LOADALL_CODE_PREFIX}0001..${String(GROUP_SIZE).padStart(4, '0')})`);
  console.log(`no-group:        ${NOGROUP_SIZE} (codes ${NOGROUP_CODE_PREFIX}001..${String(NOGROUP_SIZE).padStart(3, '0')})`);
  console.log(`stock balances:  ${GROUP_SIZE} @ "${warehouse.name}" (code=id=${warehouse.code})`);
  console.log(`manifest:        .verifier-electron/nomenclature-verify-fixture.json`);
}

main()
  .catch((e) => {
    console.error('[seed-nomenclature-verify] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import { AttributeDataType, EntityTypeCode } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import {
  createEntity,
  setEntityAttribute,
  upsertAttributeDef,
  upsertEntityType,
} from '../services/adminMasterdataService.js';
import {
  createDirectoryPart,
  getWarehouseNomenclaturePartSpec,
  listWarehouseNomenclaturePartSpecs,
  upsertWarehouseNomenclature,
  upsertWarehouseNomenclaturePartSpec,
} from '../services/warehouseService.js';
import { upsertWarehouseAssemblyBom } from '../services/warehouseBomService.js';
import { getEmployeeAuthByLogin } from '../services/employeeAuthService.js';

// Deterministic BOM id so re-runs update the same fixture (and it stays the newest → primary).
const VARIANT_BOM_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee5';

let ACTOR: { id: string; username: string; role: 'admin' | 'superadmin' } = {
  id: '00000000-0000-0000-0000-000000000000',
  username: 'verify-seed',
  role: 'superadmin',
};

async function ensureEntityTypeIdByCode(code: string, name: string) {
  const existing = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return String(existing[0].id);
  const r = await upsertEntityType(ACTOR, { code, name });
  if (!r.ok || !r.id) throw new Error(`upsertEntityType ${code}: ${(r as any).error ?? 'failed'}`);
  return r.id;
}

async function ensureAttr(entityTypeId: string, code: string, name: string, dataType: string, sortOrder: number) {
  const existing = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return String(existing[0].id);
  const r = await upsertAttributeDef(ACTOR, { entityTypeId, code, name, dataType, sortOrder });
  if (!r.ok || !r.id) throw new Error(`upsertAttributeDef ${code}: ${(r as any).error ?? 'failed'}`);
  return r.id;
}

async function findBrandId(name: string): Promise<string> {
  const typeId = await ensureEntityTypeIdByCode(EntityTypeCode.EngineBrand, 'Марка двигателя');
  await ensureAttr(typeId, 'name', 'Название', AttributeDataType.Text, 10);
  const attrDef = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (!attrDef[0]) throw new Error('name attr def missing');
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .innerJoin(attributeValues, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(entities.typeId, typeId as any),
        isNull(entities.deletedAt),
        eq(attributeValues.attributeDefId, attrDef[0].id),
        eq(attributeValues.valueJson, JSON.stringify(name)),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);
  if (rows[0]?.id) return String(rows[0].id);
  // create if missing
  const created = await createEntity(ACTOR, typeId);
  if (!created.ok || !created.id) throw new Error(`createEntity (brand): ${(created as any).error ?? 'failed'}`);
  await setEntityAttribute(ACTOR, created.id, 'name', name);
  return created.id;
}

async function ensurePartWithBrandLink(name: string, brandId: string, assemblyUnitNumber: string, quantity: number): Promise<string> {
  let partId = '';
  const listed = await listWarehouseNomenclaturePartSpecs();
  if (listed.ok) {
    const match = listed.rows.find((r) => r.name === name);
    if (match) partId = match.id;
  }
  if (!partId) {
    const created = await createDirectoryPart({ name });
    if (created.ok) partId = created.part.id;
    else {
      const dup = String(created.error || '').match(/duplicate part exists:\s*([0-9a-f-]{36})/i);
      if (dup?.[1]) partId = dup[1];
      else throw new Error(`createDirectoryPart: ${created.error}`);
    }
  }
  const cur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: partId });
  if (!cur.ok) throw new Error(`getWarehouseNomenclaturePartSpec: ${cur.error}`);
  const spec = cur.spec ?? { code: null, templateId: null, dimensions: [], brandLinks: [] };
  if (!spec.brandLinks.some((l) => String(l.engineBrandId) === brandId)) {
    const merged = { ...spec, brandLinks: [...spec.brandLinks, { id: randomUUID(), engineBrandId: brandId, assemblyUnitNumber, quantity }] };
    const up = await upsertWarehouseNomenclaturePartSpec({ nomenclatureId: partId, spec: merged });
    if (!up.ok) throw new Error(`upsertWarehouseNomenclaturePartSpec: ${up.error}`);
  }
  // BOM line FK → erp_nomenclature.id. Phase 3 id-identity: create the nomenclature row
  // with the SAME id as the directory_parts row so componentNomenclatureId == inventory row id.
  const nom = await upsertWarehouseNomenclature({ id: partId, code: name, name, itemType: 'part' });
  if (!nom.ok) throw new Error(`upsertWarehouseNomenclature(${name}): ${nom.error}`);
  return partId;
}

async function main() {
  const valstan = await getEmployeeAuthByLogin('valstan');
  if (valstan) ACTOR = { id: valstan.id, username: 'valstan', role: 'superadmin' };

  const brandId = await findBrandId('TEST-BRAND');
  console.log(`[variant-seed] brand TEST-BRAND = ${brandId}`);

  const varA = await ensurePartWithBrandLink('VAR-A-PART', brandId, 'UN-A', 1);
  const varB = await ensurePartWithBrandLink('VAR-B-PART', brandId, 'UN-B', 1);
  console.log(`[variant-seed] VAR-A-PART = ${varA}`);
  console.log(`[variant-seed] VAR-B-PART = ${varB}`);

  const up = await upsertWarehouseAssemblyBom({
    id: VARIANT_BOM_ID,
    name: 'TEST-BRAND BOM (variants A/B)',
    engineBrandIds: [brandId],
    isDefault: true,
    status: 'active',
    lines: [
      { componentNomenclatureId: varA, variantGroup: 'A', qtyPerUnit: 1, componentType: 'part' },
      { componentNomenclatureId: varB, variantGroup: 'B', qtyPerUnit: 1, componentType: 'part' },
    ],
    actor: ACTOR,
  });
  if (!up.ok) throw new Error(`upsertWarehouseAssemblyBom: ${up.error}`);
  console.log(`[variant-seed] BOM upserted: ${up.id} (warnings: ${JSON.stringify((up as any).warnings ?? [])})`);

  console.log('');
  console.log('=== Variant BOM verify fixture ready ===');
  console.log(`brandId=${brandId} varA=${varA} varB=${varB} bomId=${up.id}`);
  console.log('TEST-PART stays a shared brand part (no BOM line → always visible).');
}

main()
  .catch((e) => {
    console.error('[variant-seed] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

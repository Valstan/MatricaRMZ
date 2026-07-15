import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';

import {
  AttributeDataType,
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  EntityTypeCode,
} from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { attributeDefs, entityTypes } from '../database/schema.js';
import { upsertAttributeDef, upsertEntityType } from '../services/adminMasterdataService.js';
import { ensureEmployeeAuthDefs } from '../services/employeeAuthService.js';

const ACTOR = { id: 'verify-bootstrap', username: 'verify-bootstrap', role: 'superadmin' } as const;

async function ensureType(code: string, name: string) {
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

async function ensureAttr(typeId: string, code: string, name: string, dataType: string, sortOrder: number, metaJson?: string) {
  const existing = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return;
  const r = await upsertAttributeDef(ACTOR, {
    entityTypeId: typeId,
    code,
    name,
    dataType,
    sortOrder,
    ...(metaJson ? { metaJson } : {}),
  });
  if (!r.ok) throw new Error(`upsertAttributeDef ${code}: ${(r as any).error ?? 'failed'}`);
}

async function main() {
  const brandId = await ensureType(EntityTypeCode.EngineBrand, 'Engine brand');
  await ensureAttr(brandId, 'name', 'Name', AttributeDataType.Text, 10);

  const partId = await ensureType(EntityTypeCode.Part, 'Part');
  await ensureAttr(partId, 'name', 'Name', AttributeDataType.Text, 10);
  await ensureAttr(partId, 'assembly_unit_number', 'Assembly unit number', AttributeDataType.Text, 20);

  const engineId = await ensureType(EntityTypeCode.Engine, 'Engine');
  await ensureAttr(engineId, 'engine_number', 'Engine number', AttributeDataType.Text, 10);
  await ensureAttr(engineId, ENGINE_INTERNAL_NUMBER_CODE, 'Внутренний номер', AttributeDataType.Text, 15);
  await ensureAttr(engineId, ENGINE_INTERNAL_NUMBER_YEAR_CODE, 'Год внутреннего номера', AttributeDataType.Number, 16);
  await ensureAttr(engineId, 'engine_brand', 'Engine brand', AttributeDataType.Text, 20);
  await ensureAttr(
    engineId,
    'engine_brand_id',
    'Engine brand (link)',
    AttributeDataType.Link,
    25,
    JSON.stringify({ linkTargetTypeCode: EntityTypeCode.EngineBrand }),
  );

  const customerId = await ensureType(EntityTypeCode.Customer, 'Customer');
  await ensureAttr(customerId, 'name', 'Name', AttributeDataType.Text, 10);

  // Engine brand groups — user-defined bundles of engine brands (bulk part attach).
  const brandGroupId = await ensureType(EntityTypeCode.EngineBrandGroup, 'Engine brand group');
  await ensureAttr(brandGroupId, 'name', 'Name', AttributeDataType.Text, 10);
  await ensureAttr(brandGroupId, 'description', 'Description', AttributeDataType.Text, 20);
  await ensureAttr(
    brandGroupId,
    'engine_brand_ids',
    'Engine brands',
    AttributeDataType.Json,
    30,
    JSON.stringify({ linkTargetTypeCode: EntityTypeCode.EngineBrand, multi: true }),
  );

  // Engine node — used by defect dropdown.
  const nodeId = await ensureType('engine_node', 'Engine node');
  await ensureAttr(nodeId, 'name', 'Name', AttributeDataType.Text, 10);

  // Section — used by employee profile.
  const sectionId = await ensureType('section', 'Section');
  await ensureAttr(sectionId, 'name', 'Name', AttributeDataType.Text, 10);

  await ensureEmployeeAuthDefs();

  console.log('[bootstrap] entity_types + attribute_defs ready');
}

main()
  .catch((e) => {
    console.error('[bootstrap] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import { AttributeDataType, EntityTypeCode } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { hashPassword } from '../auth/password.js';
import {
  createEmployeeEntity,
  ensureEmployeeAuthDefs,
  getEmployeeAuthByLogin,
  setEmployeeAuth,
  setEmployeeFullName,
} from '../services/employeeAuthService.js';
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
  upsertWarehouseNomenclaturePartSpec,
} from '../services/warehouseService.js';

// row_owners.owner_user_id is uuid + FK on users.id on a prod-snapshot schema,
// so ACTOR.id must be an existing user uuid by the time admin services run.
// main() replaces this with the freshly-ensured valstan superadmin uuid.
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

async function ensureAttr(
  entityTypeId: string,
  code: string,
  name: string,
  dataType: string,
  sortOrder: number,
  metaJson?: string | null,
) {
  const existing = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(
      and(
        eq(attributeDefs.entityTypeId, entityTypeId as any),
        eq(attributeDefs.code, code),
        isNull(attributeDefs.deletedAt),
      ),
    )
    .limit(1);
  if (existing[0]?.id) return String(existing[0].id);
  const r = await upsertAttributeDef(ACTOR, {
    entityTypeId,
    code,
    name,
    dataType,
    sortOrder,
    ...(metaJson != null ? { metaJson } : {}),
  });
  if (!r.ok || !r.id) throw new Error(`upsertAttributeDef ${code}: ${(r as any).error ?? 'failed'}`);
  return r.id;
}

async function findEntityIdByTextAttr(typeId: string, attrCode: string, value: string): Promise<string | null> {
  const attrDef = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(
      and(
        eq(attributeDefs.entityTypeId, typeId as any),
        eq(attributeDefs.code, attrCode),
        isNull(attributeDefs.deletedAt),
      ),
    )
    .limit(1);
  if (!attrDef[0]) return null;
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .innerJoin(attributeValues, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(entities.typeId, typeId as any),
        isNull(entities.deletedAt),
        eq(attributeValues.attributeDefId, attrDef[0].id),
        eq(attributeValues.valueJson, JSON.stringify(value)),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function ensureBrand(name: string): Promise<string> {
  const typeId = await ensureEntityTypeIdByCode(EntityTypeCode.EngineBrand, 'Марка двигателя');
  await ensureAttr(typeId, 'name', 'Название', AttributeDataType.Text, 10);
  const existing = await findEntityIdByTextAttr(typeId, 'name', name);
  if (existing) return existing;
  const created = await createEntity(ACTOR, typeId);
  if (!created.ok || !created.id) throw new Error(`createEntity (brand): ${(created as any).error ?? 'failed'}`);
  await setEntityAttribute(ACTOR, created.id, 'name', name);
  return created.id;
}

async function ensureDepartment(name: string): Promise<string> {
  const typeId = await ensureEntityTypeIdByCode(EntityTypeCode.Department, 'Подразделение');
  await ensureAttr(typeId, 'name', 'Название', AttributeDataType.Text, 10);
  const existing = await findEntityIdByTextAttr(typeId, 'name', name);
  if (existing) return existing;
  const created = await createEntity(ACTOR, typeId);
  if (!created.ok || !created.id) throw new Error(`createEntity (department): ${(created as any).error ?? 'failed'}`);
  await setEntityAttribute(ACTOR, created.id, 'name', name);
  return created.id;
}

// Supply requests require the actor to have a department in their profile
// (createSupplyRequest rejects with "Не задано подразделение" otherwise — admins are
// not exempt, only superadmin). Prod employees always carry one; the dev verify user
// is created fresh, so seed it here. Without it the «Заявка в снабжение из негодных»
// flow fails at create() even though the button renders.
async function assignEmployeeDepartment(employeeId: string, departmentId: string): Promise<void> {
  const empTypeId = await ensureEntityTypeIdByCode(EntityTypeCode.Employee, 'Сотрудник');
  await ensureAttr(
    empTypeId,
    'department_id',
    'Подразделение',
    AttributeDataType.Link,
    40,
    JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Department }),
  );
  await setEntityAttribute(ACTOR, employeeId, 'department_id', departmentId);
}

async function ensureEngine(engineNumber: string, brandName: string, brandId: string): Promise<string> {
  const typeId = await ensureEntityTypeIdByCode(EntityTypeCode.Engine, 'Двигатель');
  await ensureAttr(typeId, 'engine_number', 'Номер двигателя', AttributeDataType.Text, 10);
  await ensureAttr(typeId, 'engine_brand', 'Марка двигателя', AttributeDataType.Text, 20);
  await ensureAttr(
    typeId,
    'engine_brand_id',
    'Марка двигателя (справочник)',
    AttributeDataType.Link,
    25,
    JSON.stringify({ linkTargetTypeCode: EntityTypeCode.EngineBrand }),
  );
  await ensureAttr(typeId, 'arrival_date', 'Дата прихода', AttributeDataType.Date, 30);

  const existing = await findEntityIdByTextAttr(typeId, 'engine_number', engineNumber);
  if (existing) return existing;

  const created = await createEntity(ACTOR, typeId);
  if (!created.ok || !created.id) throw new Error(`createEntity (engine): ${(created as any).error ?? 'failed'}`);
  await setEntityAttribute(ACTOR, created.id, 'engine_number', engineNumber);
  await setEntityAttribute(ACTOR, created.id, 'engine_brand', brandName);
  await setEntityAttribute(ACTOR, created.id, 'engine_brand_id', brandId);
  await setEntityAttribute(ACTOR, created.id, 'arrival_date', Date.now());
  return created.id;
}

// Phase 3.7 WS2: directory-native. The part is a directory_parts row; the brand
// link lives in its brand_links_json (no parts/part_engine_brand EAV).
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
    const merged = {
      ...spec,
      brandLinks: [...spec.brandLinks, { id: randomUUID(), engineBrandId: brandId, assemblyUnitNumber, quantity }],
    };
    const up = await upsertWarehouseNomenclaturePartSpec({ nomenclatureId: partId, spec: merged });
    if (!up.ok) throw new Error(`upsertWarehouseNomenclaturePartSpec: ${up.error}`);
  }
  return partId;
}

async function ensureEmployee(login: string, password: string, role: 'admin' | 'superadmin', fullName: string): Promise<string> {
  await ensureEmployeeAuthDefs();
  const passwordHash = await hashPassword(password);
  const existing = await getEmployeeAuthByLogin(login);
  if (existing) {
    // When seeding into a prod-snapshot DB (verifier-electron full restore), the
    // existing employee row may already carry attribute_values with newer sync
    // seq than what setEmployeeAuth will push, causing applyPushBatch to throw
    // `sync_conflict: attribute_values`. We keep the existing record untouched
    // in that case — for verify we only really need the `verify` user; existing
    // prod accounts (valstan/admin/...) are not used by the verify flow.
    try {
      await setEmployeeAuth(existing.id, { passwordHash, systemRole: role, accessEnabled: true, login });
      if (fullName) await setEmployeeFullName(existing.id, fullName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[seed] keep existing ${login} as-is (cannot update on prod-snapshot DB): ${msg}`);
    }
    return existing.id;
  }
  const id = randomUUID();
  const created = await createEmployeeEntity(id);
  if (!created.ok) throw new Error(`createEmployeeEntity: ${(created as any).error ?? 'failed'}`);
  await setEmployeeAuth(id, { passwordHash, systemRole: role, accessEnabled: true, login });
  if (fullName) await setEmployeeFullName(id, fullName);
  return id;
}

async function main() {
  const verifyLogin = process.env.MATRICA_VERIFY_LOGIN?.trim() || 'verify';
  const verifyPassword = process.env.MATRICA_VERIFY_PASSWORD?.trim() || 'verify123';
  const superadminPassword = process.env.MATRICA_SUPERADMIN_PASSWORD?.trim() || 'valstan-dev';

  console.log(`[seed] valstan (superadmin) ...`);
  const valstanId = await ensureEmployee('valstan', superadminPassword, 'superadmin', 'Superadmin (dev)');
  ACTOR = { id: valstanId, username: 'valstan', role: 'superadmin' };

  console.log(`[seed] ${verifyLogin} / ${verifyPassword} (admin) ...`);
  const verifyUserId = await ensureEmployee(verifyLogin, verifyPassword, 'admin', 'Verifier (dev)');

  console.log(`[seed] TEST-DEPT + assign to ${verifyLogin} ...`);
  const departmentId = await ensureDepartment('TEST-DEPT');
  await assignEmployeeDepartment(verifyUserId, departmentId);

  console.log(`[seed] TEST-BRAND ...`);
  const brandId = await ensureBrand('TEST-BRAND');

  console.log(`[seed] TEST-PART (qty=2 на TEST-BRAND, UN=UN-001) ...`);
  const partId = await ensurePartWithBrandLink('TEST-PART', brandId, 'UN-001', 2);

  console.log(`[seed] TEST-001 (двигатель TEST-BRAND) ...`);
  const engineId = await ensureEngine('TEST-001', 'TEST-BRAND', brandId);

  console.log('');
  console.log('=== Verifier dev fixtures ready ===');
  console.log(`verify user id:     ${verifyUserId}`);
  console.log(`brand id (TEST):    ${brandId}`);
  console.log(`part id (TEST):     ${partId}`);
  console.log(`engine id (001):    ${engineId}`);
  console.log('');
  console.log(`Login:  ${verifyLogin}`);
  console.log(`Pass:   ${verifyPassword}`);
}

main()
  .catch((e) => {
    console.error('[seed] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

import { and, eq, isNull } from 'drizzle-orm';

import { AttributeDataType, EntityTypeCode } from '@matricarmz/shared';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { db } from '../database/db.js';
import { upsertAttributeDef, upsertEntityType, createEntity, setEntityAttribute } from './adminMasterdataService.js';
import { logError, logInfo } from '../utils/logger.js';
import { getSuperadminUserId } from './employeeAuthService.js';

function nowMs() {
  return Date.now();
}

async function resolveActor() {
  const superadminId = await getSuperadminUserId().catch(() => null);
  if (superadminId) return { id: superadminId, username: 'superadmin' };
  const employeeType = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, EntityTypeCode.Employee), isNull(entityTypes.deletedAt)))
    .limit(1);
  if (employeeType[0]?.id) {
    const anyEmployee = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.typeId, employeeType[0].id as any), isNull(entities.deletedAt)))
      .limit(1);
    if (anyEmployee[0]?.id) return { id: String(anyEmployee[0].id), username: 'system' };
  }
  return null;
}

async function ensureEntityType(actor: { id: string; username: string }, code: string, name: string) {
  const existing = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  if (existing[0]) return String(existing[0].id);
  const r = await upsertEntityType(actor, { code, name });
  if (!r.ok || !r.id) throw new Error(`failed to upsert entity type: ${code}`);
  return String(r.id);
}

async function ensureAttrDef(
  actor: { id: string; username: string },
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
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existing[0]) return String(existing[0].id);
  const r = await upsertAttributeDef(actor, {
    entityTypeId,
    code,
    name,
    dataType,
    sortOrder,
    metaJson: metaJson ?? null,
  });
  if (!r.ok || !r.id) throw new Error(`failed to upsert attribute def: ${entityTypeId} ${code}`);
  return String(r.id);
}

async function findEntityByName(entityTypeId: string, nameDefId: string, name: string) {
  const rows = await db
    .select({ entityId: attributeValues.entityId })
    .from(attributeValues)
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(attributeValues.attributeDefId, nameDefId as any),
        eq(attributeValues.valueJson, JSON.stringify(name)),
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        eq(entities.typeId, entityTypeId as any),
      ),
    )
    .limit(1);
  return rows[0]?.entityId ? String(rows[0].entityId) : null;
}

async function ensureEntityWithName(
  actor: { id: string; username: string },
  entityTypeId: string,
  nameDefId: string,
  name: string,
  attrs?: Record<string, unknown>,
) {
  const existing = await findEntityByName(entityTypeId, nameDefId, name);
  if (existing) return existing;
  const created = await createEntity(actor, entityTypeId);
  if (!created.ok || !created.id) throw new Error(`failed to create entity: ${name}`);
  await setEntityAttribute(actor, created.id, 'name', name);
  if (attrs) {
    for (const [code, value] of Object.entries(attrs)) {
      await setEntityAttribute(actor, created.id, code, value);
    }
  }
  return created.id;
}

export async function ensureBaseMasterdata() {
  try {
    const actor = await resolveActor();
    if (!actor) {
      logError('base masterdata ensure skipped: actor not found', {});
      return;
    }

    const unitTypeId = await ensureEntityType(actor, EntityTypeCode.Unit, 'Единицы измерения');
    const storeTypeId = await ensureEntityType(actor, EntityTypeCode.Store, 'Магазины');
    const engineNodeTypeId = await ensureEntityType(actor, EntityTypeCode.EngineNode, 'Узлы двигателя');
    const employeeTypeId = await ensureEntityType(actor, EntityTypeCode.Employee, 'Сотрудник');
    const departmentTypeId = await ensureEntityType(actor, EntityTypeCode.Department, 'Подразделение / служба');
    const sectionTypeId = await ensureEntityType(actor, EntityTypeCode.Section, 'Участок');
    const categoryTypeId = await ensureEntityType(actor, EntityTypeCode.Category, 'Категории');

    const unitNameDefId = await ensureAttrDef(actor, unitTypeId, 'name', 'Название', AttributeDataType.Text, 10);
    const storeNameDefId = await ensureAttrDef(actor, storeTypeId, 'name', 'Наименование', AttributeDataType.Text, 10);
    await ensureAttrDef(actor, storeTypeId, 'address', 'Адрес', AttributeDataType.Text, 20);
    await ensureAttrDef(actor, storeTypeId, 'inn', 'ИНН', AttributeDataType.Text, 30);
    await ensureAttrDef(actor, storeTypeId, 'phone', 'Телефон', AttributeDataType.Text, 40);
    await ensureAttrDef(actor, storeTypeId, 'email', 'Email', AttributeDataType.Text, 50);
    await ensureAttrDef(actor, engineNodeTypeId, 'name', 'Наименование', AttributeDataType.Text, 10);

    const units = ['шт', 'кг', 'г', 'л', 'м', 'см', 'мм', 'м2', 'м3', 'комплект'];
    for (const u of units) {
      await ensureEntityWithName(actor, unitTypeId, unitNameDefId, u);
    }

    await ensureEntityWithName(actor, storeTypeId, storeNameDefId, 'ИП Асхатзянов', {});
    await ensureEntityWithName(actor, storeTypeId, storeNameDefId, 'Евротех', {});

    await ensureAttrDef(actor, departmentTypeId, 'name', 'Название', AttributeDataType.Text, 10);
    await ensureAttrDef(actor, sectionTypeId, 'name', 'Название', AttributeDataType.Text, 10);
    await ensureAttrDef(actor, categoryTypeId, 'name', 'Название', AttributeDataType.Text, 10);

    await ensureAttrDef(actor, employeeTypeId, 'last_name', 'Фамилия', AttributeDataType.Text, 10);
    await ensureAttrDef(actor, employeeTypeId, 'first_name', 'Имя', AttributeDataType.Text, 20);
    await ensureAttrDef(actor, employeeTypeId, 'middle_name', 'Отчество', AttributeDataType.Text, 30);
    await ensureAttrDef(actor, employeeTypeId, 'full_name', 'ФИО', AttributeDataType.Text, 40);
    await ensureAttrDef(actor, employeeTypeId, 'personnel_number', 'Табельный номер', AttributeDataType.Text, 45);
    await ensureAttrDef(actor, employeeTypeId, 'birth_date', 'Дата рождения', AttributeDataType.Date, 48);
    await ensureAttrDef(actor, employeeTypeId, 'role', 'Должность', AttributeDataType.Text, 50);
    await ensureAttrDef(actor, employeeTypeId, 'employment_status', 'Статус (работает/уволен)', AttributeDataType.Text, 55);
    await ensureAttrDef(actor, employeeTypeId, 'hire_date', 'Дата приема на работу', AttributeDataType.Date, 56);
    await ensureAttrDef(actor, employeeTypeId, 'termination_date', 'Дата увольнения', AttributeDataType.Date, 57);
    await ensureAttrDef(
      actor,
      employeeTypeId,
      'category_id',
      'Категория',
      AttributeDataType.Link,
      58,
      JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Category }),
    );
    await ensureAttrDef(
      actor,
      employeeTypeId,
      'department_id',
      'Подразделение',
      AttributeDataType.Link,
      60,
      JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Department }),
    );
    await ensureAttrDef(
      actor,
      employeeTypeId,
      'section_id',
      'Участок',
      AttributeDataType.Link,
      70,
      JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Section }),
    );
    await ensureAttrDef(actor, employeeTypeId, 'transfers', 'Переводы', AttributeDataType.Json, 80);
    await ensureAttrDef(actor, employeeTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

    logInfo('base masterdata ensured', { at: nowMs() });
  } catch (e) {
    logError('base masterdata ensure failed', { error: String(e) });
  }
}

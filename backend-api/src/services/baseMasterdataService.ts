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
  const existingAny = await db
    .select({ id: entityTypes.id, deletedAt: entityTypes.deletedAt })
    .from(entityTypes)
    .where(eq(entityTypes.code, code))
    .limit(1);
  if (existingAny[0]) {
    if (existingAny[0].deletedAt != null) {
      logInfo('base masterdata: entity type deleted, skip ensure', { code, id: String(existingAny[0].id) });
      return null;
    }
    return String(existingAny[0].id);
  }
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

async function ensureAttrDefIfType(
  actor: { id: string; username: string },
  entityTypeId: string | null,
  code: string,
  name: string,
  dataType: string,
  sortOrder: number,
  metaJson?: string | null,
) {
  if (!entityTypeId) return null;
  return ensureAttrDef(actor, entityTypeId, code, name, dataType, sortOrder, metaJson);
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

async function ensureEntityWithNameIfType(
  actor: { id: string; username: string },
  entityTypeId: string | null,
  nameDefId: string | null,
  name: string,
  attrs?: Record<string, unknown>,
) {
  if (!entityTypeId || !nameDefId) return null;
  return ensureEntityWithName(actor, entityTypeId, nameDefId, name, attrs);
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

    const unitNameDefId = await ensureAttrDefIfType(actor, unitTypeId, 'name', 'Название', AttributeDataType.Text, 10);
    const storeNameDefId = await ensureAttrDefIfType(actor, storeTypeId, 'name', 'Наименование', AttributeDataType.Text, 10);
    await ensureAttrDefIfType(actor, storeTypeId, 'address', 'Адрес', AttributeDataType.Text, 20);
    await ensureAttrDefIfType(actor, storeTypeId, 'inn', 'ИНН', AttributeDataType.Text, 30);
    await ensureAttrDefIfType(actor, storeTypeId, 'phone', 'Телефон', AttributeDataType.Text, 40);
    await ensureAttrDefIfType(actor, storeTypeId, 'email', 'Email', AttributeDataType.Text, 50);
    await ensureAttrDefIfType(actor, engineNodeTypeId, 'name', 'Наименование', AttributeDataType.Text, 10);

    const units = ['шт', 'кг', 'г', 'л', 'м', 'см', 'мм', 'м2', 'м3', 'комплект'];
    for (const u of units) {
      await ensureEntityWithNameIfType(actor, unitTypeId, unitNameDefId, u);
    }

    await ensureEntityWithNameIfType(actor, storeTypeId, storeNameDefId, 'ИП Асхатзянов', {});
    await ensureEntityWithNameIfType(actor, storeTypeId, storeNameDefId, 'Евротех', {});

    await ensureAttrDefIfType(actor, departmentTypeId, 'name', 'Название', AttributeDataType.Text, 10);
    await ensureAttrDefIfType(actor, sectionTypeId, 'name', 'Название', AttributeDataType.Text, 10);
    await ensureAttrDefIfType(actor, categoryTypeId, 'name', 'Название', AttributeDataType.Text, 10);

    await ensureAttrDefIfType(actor, employeeTypeId, 'last_name', 'Фамилия', AttributeDataType.Text, 10);
    await ensureAttrDefIfType(actor, employeeTypeId, 'first_name', 'Имя', AttributeDataType.Text, 20);
    await ensureAttrDefIfType(actor, employeeTypeId, 'middle_name', 'Отчество', AttributeDataType.Text, 30);
    await ensureAttrDefIfType(actor, employeeTypeId, 'full_name', 'ФИО', AttributeDataType.Text, 40);
    await ensureAttrDefIfType(actor, employeeTypeId, 'personnel_number', 'Табельный номер', AttributeDataType.Text, 45);
    await ensureAttrDefIfType(actor, employeeTypeId, 'birth_date', 'Дата рождения', AttributeDataType.Date, 48);
    await ensureAttrDefIfType(actor, employeeTypeId, 'role', 'Должность', AttributeDataType.Text, 50);
    await ensureAttrDefIfType(actor, employeeTypeId, 'employment_status', 'Статус (работает/уволен)', AttributeDataType.Text, 55);
    await ensureAttrDefIfType(actor, employeeTypeId, 'hire_date', 'Дата приема на работу', AttributeDataType.Date, 56);
    await ensureAttrDefIfType(actor, employeeTypeId, 'termination_date', 'Дата увольнения', AttributeDataType.Date, 57);
    if (employeeTypeId && categoryTypeId) {
      await ensureAttrDefIfType(
        actor,
        employeeTypeId,
        'category_id',
        'Категория',
        AttributeDataType.Link,
        58,
        JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Category }),
      );
    }
    if (employeeTypeId && departmentTypeId) {
      await ensureAttrDefIfType(
        actor,
        employeeTypeId,
        'department_id',
        'Подразделение',
        AttributeDataType.Link,
        60,
        JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Department }),
      );
    }
    if (employeeTypeId && sectionTypeId) {
      await ensureAttrDefIfType(
        actor,
        employeeTypeId,
        'section_id',
        'Участок',
        AttributeDataType.Link,
        70,
        JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Section }),
      );
    }
    await ensureAttrDefIfType(actor, employeeTypeId, 'transfers', 'Переводы', AttributeDataType.Json, 80);
    await ensureAttrDefIfType(actor, employeeTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

    logInfo('base masterdata ensured', { at: nowMs() });
  } catch (e) {
    logError('base masterdata ensure failed', { error: String(e) });
  }
}

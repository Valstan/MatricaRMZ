import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { AttributeDataType, EntityTypeCode } from '@matricarmz/shared';
import { attributeDefs, entityTypes } from './schema.js';

function nowMs() {
  return Date.now();
}

export async function seedIfNeeded(db: BetterSQLite3Database) {
  const ts = nowMs();

  async function ensureEntityType(code: string, name: string): Promise<string> {
    const existing = await db.select().from(entityTypes).where(eq(entityTypes.code, code)).limit(1);
    if (existing[0]) {
      // Не перетираем пользовательские названия. Обновляем только если:
      // - имя пустое, или
      // - это старое системное имя (из прошлых seed).
      const currentName = String(existing[0].name ?? '').trim();
      const nextName = String(name ?? '').trim();
      const shouldUpdate =
        !currentName ||
        (code === EntityTypeCode.Product && (currentName === 'Товары (номенклатура)' || currentName === 'Товары/услуги'));

      if (shouldUpdate && currentName !== nextName) {
        await db
          .update(entityTypes)
          .set({ name: nextName, updatedAt: ts, syncStatus: 'pending' })
          .where(eq(entityTypes.id, existing[0].id));
      }
      return existing[0].id;
    }

    const id = randomUUID();
    await db.insert(entityTypes).values({
      id,
      code,
      name,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    return id;
  }

  const engineTypeId = await ensureEntityType(EntityTypeCode.Engine, 'Двигатель');
  const engineBrandTypeId = await ensureEntityType(EntityTypeCode.EngineBrand, 'Марка двигателя');
  const customerTypeId = await ensureEntityType(EntityTypeCode.Customer, 'Заказчик');
  const contractTypeId = await ensureEntityType(EntityTypeCode.Contract, 'Контракт');
  const workOrderTypeId = await ensureEntityType(EntityTypeCode.WorkOrder, 'Наряд');
  const workshopTypeId = await ensureEntityType(EntityTypeCode.Workshop, 'Цех');
  const sectionTypeId = await ensureEntityType(EntityTypeCode.Section, 'Участок');
  const departmentTypeId = await ensureEntityType(EntityTypeCode.Department, 'Подразделение / служба');
  const productTypeId = await ensureEntityType(EntityTypeCode.Product, 'Номенклатура (товары/услуги)');
  const employeeTypeId = await ensureEntityType(EntityTypeCode.Employee, 'Сотрудник');

  async function ensureAttrDef(
    entityTypeId: string,
    code: string,
    name: string,
    dataType: string,
    sortOrder: number,
    metaJson?: string | null,
  ) {
    const found = await db
      .select()
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, entityTypeId), eq(attributeDefs.code, code)))
      .limit(1);
    if (found[0]) {
      const currentName = String(found[0].name ?? '').trim();
      const nextName = String(name ?? '').trim();

      // metaJson обновляем только если у текущего нет target'а, а у нас он есть.
      const currentMeta = found[0].metaJson ? String(found[0].metaJson) : null;
      const nextMeta = metaJson ?? null;

      const needsNameUpdate = !currentName && currentName !== nextName;
      const needsMetaUpdate = !!nextMeta && (!currentMeta || !currentMeta.includes('"linkTargetTypeCode"'));

      if (needsNameUpdate || needsMetaUpdate) {
        await db
          .update(attributeDefs)
          .set({
            ...(needsNameUpdate ? { name: nextName } : {}),
            ...(needsMetaUpdate ? { metaJson: nextMeta } : {}),
            updatedAt: ts,
            syncStatus: 'pending',
          })
          .where(eq(attributeDefs.id, found[0].id));
      }

      return found[0].id;
    }

    const id = randomUUID();
    await db.insert(attributeDefs).values({
      id,
      entityTypeId,
      code,
      name,
      dataType,
      isRequired: false,
      sortOrder,
      metaJson: metaJson ?? null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    return id;
  }

  // Минимальные поля для MVP (гибкая структура будет расширяться).
  await ensureAttrDef(engineTypeId, 'engine_number', 'Номер двигателя', AttributeDataType.Text, 10);
  await ensureAttrDef(engineTypeId, 'engine_brand', 'Марка двигателя', AttributeDataType.Text, 20);
  await ensureAttrDef(
    engineTypeId,
    'engine_brand_id',
    'Марка двигателя (справочник)',
    AttributeDataType.Link,
    25,
    JSON.stringify({ linkTargetTypeCode: EntityTypeCode.EngineBrand }),
  );
  await ensureAttrDef(engineTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

  // Engine master-data links (минимально, чтобы начать привязку).
  await ensureAttrDef(engineTypeId, 'customer_id', 'Заказчик', AttributeDataType.Link, 30, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Customer }));
  await ensureAttrDef(engineTypeId, 'contract_id', 'Контракт', AttributeDataType.Link, 40, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Contract }));
  await ensureAttrDef(engineTypeId, 'work_order_id', 'Наряд', AttributeDataType.Link, 50, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.WorkOrder }));
  await ensureAttrDef(engineTypeId, 'workshop_id', 'Цех', AttributeDataType.Link, 60, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Workshop }));
  await ensureAttrDef(engineTypeId, 'section_id', 'Участок', AttributeDataType.Link, 70, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Section }));

  // Common attachments for all master-data entities (универсально, чтобы "везде" можно было прикреплять файлы).
  // EngineBrand (марки двигателя) — минимум: имя + вложения.
  await ensureAttrDef(engineBrandTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttrDef(engineBrandTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

  // Customer
  await ensureAttrDef(customerTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttrDef(customerTypeId, 'inn', 'ИНН', AttributeDataType.Text, 20);
  await ensureAttrDef(customerTypeId, 'kpp', 'КПП', AttributeDataType.Text, 30);
  await ensureAttrDef(customerTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

  // Contract (link to customer)
  await ensureAttrDef(contractTypeId, 'number', 'Номер договора', AttributeDataType.Text, 10);
  await ensureAttrDef(contractTypeId, 'date', 'Дата договора', AttributeDataType.Date, 20);
  await ensureAttrDef(contractTypeId, 'customer_id', 'Заказчик', AttributeDataType.Link, 30, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Customer }));
  await ensureAttrDef(contractTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

  // Work order (link to contract)
  await ensureAttrDef(workOrderTypeId, 'number', 'Номер наряда', AttributeDataType.Text, 10);
  await ensureAttrDef(workOrderTypeId, 'date', 'Дата наряда', AttributeDataType.Date, 20);
  await ensureAttrDef(workOrderTypeId, 'contract_id', 'Контракт', AttributeDataType.Link, 30, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Contract }));
  await ensureAttrDef(workOrderTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

  // Workshop / Section
  await ensureAttrDef(workshopTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttrDef(workshopTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);
  await ensureAttrDef(sectionTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttrDef(sectionTypeId, 'workshop_id', 'Цех', AttributeDataType.Link, 20, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Workshop }));
  await ensureAttrDef(sectionTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

  // Department (подразделение / служба)
  await ensureAttrDef(departmentTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttrDef(departmentTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

  // Products (номенклатура)
  await ensureAttrDef(productTypeId, 'name', 'Наименование', AttributeDataType.Text, 10);
  await ensureAttrDef(productTypeId, 'unit', 'Единица измерения', AttributeDataType.Text, 20);
  await ensureAttrDef(productTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);

  // Employee
  await ensureAttrDef(employeeTypeId, 'last_name', 'Фамилия', AttributeDataType.Text, 10);
  await ensureAttrDef(employeeTypeId, 'first_name', 'Имя', AttributeDataType.Text, 20);
  await ensureAttrDef(employeeTypeId, 'middle_name', 'Отчество', AttributeDataType.Text, 30);
  await ensureAttrDef(employeeTypeId, 'full_name', 'ФИО', AttributeDataType.Text, 40);
  await ensureAttrDef(employeeTypeId, 'role', 'Должность', AttributeDataType.Text, 50);
  await ensureAttrDef(
    employeeTypeId,
    'department_id',
    'Подразделение',
    AttributeDataType.Link,
    60,
    JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Department }),
  );
  await ensureAttrDef(employeeTypeId, 'section_id', 'Участок', AttributeDataType.Link, 70, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Section }));
  await ensureAttrDef(employeeTypeId, 'attachments', 'Вложения', AttributeDataType.Json, 9990);
}



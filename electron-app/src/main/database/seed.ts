import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
    if (existing[0]) return existing[0].id;

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
  await ensureEntityType(EntityTypeCode.EngineBrand, 'Марка двигателя');
  const customerTypeId = await ensureEntityType(EntityTypeCode.Customer, 'Заказчик');
  const contractTypeId = await ensureEntityType(EntityTypeCode.Contract, 'Контракт');
  const workOrderTypeId = await ensureEntityType(EntityTypeCode.WorkOrder, 'Наряд');
  const workshopTypeId = await ensureEntityType(EntityTypeCode.Workshop, 'Цех');
  const sectionTypeId = await ensureEntityType(EntityTypeCode.Section, 'Участок');
  const departmentTypeId = await ensureEntityType(EntityTypeCode.Department, 'Подразделение / служба');
  const employeeTypeId = await ensureEntityType(EntityTypeCode.Employee, 'Сотрудник');

  async function ensureAttrDef(
    entityTypeId: string,
    code: string,
    name: string,
    dataType: string,
    sortOrder: number,
  ) {
    const existing = await db
      .select()
      .from(attributeDefs)
      .where(eq(attributeDefs.entityTypeId, entityTypeId))
      .limit(50);
    const found = existing.find((x) => x.code === code);
    if (found) return found.id;

    const id = randomUUID();
    await db.insert(attributeDefs).values({
      id,
      entityTypeId,
      code,
      name,
      dataType,
      isRequired: false,
      sortOrder,
      metaJson: null,
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

  // Engine master-data links (минимально, чтобы начать привязку).
  await ensureAttrDef(engineTypeId, 'customer_id', 'Заказчик', AttributeDataType.Link, 30);
  await ensureAttrDef(engineTypeId, 'contract_id', 'Контракт', AttributeDataType.Link, 40);
  await ensureAttrDef(engineTypeId, 'work_order_id', 'Наряд', AttributeDataType.Link, 50);
  await ensureAttrDef(engineTypeId, 'workshop_id', 'Цех', AttributeDataType.Link, 60);
  await ensureAttrDef(engineTypeId, 'section_id', 'Участок', AttributeDataType.Link, 70);

  // Customer
  await ensureAttrDef(customerTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttrDef(customerTypeId, 'inn', 'ИНН', AttributeDataType.Text, 20);
  await ensureAttrDef(customerTypeId, 'kpp', 'КПП', AttributeDataType.Text, 30);

  // Contract (link to customer)
  await ensureAttrDef(contractTypeId, 'number', 'Номер договора', AttributeDataType.Text, 10);
  await ensureAttrDef(contractTypeId, 'date', 'Дата договора', AttributeDataType.Date, 20);
  await ensureAttrDef(contractTypeId, 'customer_id', 'Заказчик', AttributeDataType.Link, 30);

  // Work order (link to contract)
  await ensureAttrDef(workOrderTypeId, 'number', 'Номер наряда', AttributeDataType.Text, 10);
  await ensureAttrDef(workOrderTypeId, 'date', 'Дата наряда', AttributeDataType.Date, 20);
  await ensureAttrDef(workOrderTypeId, 'contract_id', 'Контракт', AttributeDataType.Link, 30);

  // Workshop / Section
  await ensureAttrDef(workshopTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttrDef(sectionTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttrDef(sectionTypeId, 'workshop_id', 'Цех', AttributeDataType.Link, 20);

  // Department (подразделение / служба)
  await ensureAttrDef(departmentTypeId, 'name', 'Название', AttributeDataType.Text, 10);

  // Employee
  await ensureAttrDef(employeeTypeId, 'full_name', 'ФИО', AttributeDataType.Text, 10);
  await ensureAttrDef(employeeTypeId, 'role', 'Роль', AttributeDataType.Text, 20);
  await ensureAttrDef(employeeTypeId, 'section_id', 'Участок', AttributeDataType.Link, 30);
}



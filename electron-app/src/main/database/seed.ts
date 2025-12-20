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
}



import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { attributeDefs, entityTypes } from '../database/schema.js';

function nowMs() {
  return Date.now();
}

export async function listEntityTypes(db: BetterSQLite3Database) {
  return db.select().from(entityTypes).where(isNull(entityTypes.deletedAt)).orderBy(asc(entityTypes.code)).limit(2000);
}

export async function upsertEntityType(db: BetterSQLite3Database, args: { id?: string; code: string; name: string }) {
  try {
    const ts = nowMs();
    const id = args.id ?? randomUUID();
    await db
      .insert(entityTypes)
      .values({
        id,
        code: args.code.trim(),
        name: args.name.trim(),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      })
      .onConflictDoUpdate({
        target: entityTypes.id,
        set: { code: args.code.trim(), name: args.name.trim(), updatedAt: ts, syncStatus: 'pending' },
      });
    return { ok: true, id } as const;
  } catch (e) {
    return { ok: false, error: String(e) } as const;
  }
}

export async function listAttributeDefsByEntityType(db: BetterSQLite3Database, entityTypeId: string) {
  return db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId), isNull(attributeDefs.deletedAt)))
    .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code))
    .limit(5000);
}

export async function upsertAttributeDef(
  db: BetterSQLite3Database,
  args: {
    id?: string;
    entityTypeId: string;
    code: string;
    name: string;
    dataType: string;
    isRequired?: boolean;
    sortOrder?: number;
    metaJson?: string | null;
  },
) {
  try {
    const ts = nowMs();
    const id = args.id ?? randomUUID();
    await db
      .insert(attributeDefs)
      .values({
        id,
        entityTypeId: args.entityTypeId,
        code: args.code.trim(),
        name: args.name.trim(),
        dataType: args.dataType,
        isRequired: !!args.isRequired,
        sortOrder: args.sortOrder ?? 0,
        metaJson: args.metaJson ?? null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      })
      .onConflictDoUpdate({
        target: attributeDefs.id,
        set: {
          entityTypeId: args.entityTypeId,
          code: args.code.trim(),
          name: args.name.trim(),
          dataType: args.dataType,
          isRequired: !!args.isRequired,
          sortOrder: args.sortOrder ?? 0,
          metaJson: args.metaJson ?? null,
          updatedAt: ts,
          syncStatus: 'pending',
        },
      });
    return { ok: true, id } as const;
  } catch (e) {
    return { ok: false, error: String(e) } as const;
  }
}



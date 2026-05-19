import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { directoryWorkshops } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export type WorkshopRow = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  displayOrder: number;
  deprecatedAt: number | null;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
};

function nowMs() {
  return Date.now();
}

function rowToDto(row: typeof directoryWorkshops.$inferSelect): WorkshopRow {
  return {
    id: String(row.id),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    isActive: Boolean(row.isActive),
    displayOrder: Number(row.displayOrder ?? 0),
    deprecatedAt: row.deprecatedAt == null ? null : Number(row.deprecatedAt),
    metadataJson: row.metadataJson ?? null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export async function listWorkshops(args?: { activeOnly?: boolean }): Promise<Result<{ rows: WorkshopRow[] }>> {
  try {
    const rows = await db
      .select()
      .from(directoryWorkshops)
      .where(isNull(directoryWorkshops.deletedAt))
      .orderBy(asc(directoryWorkshops.displayOrder), asc(directoryWorkshops.name));
    const filtered = args?.activeOnly === true ? rows.filter((row) => Boolean(row.isActive)) : rows;
    return { ok: true, rows: filtered.map(rowToDto) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWorkshop(args: {
  id?: string;
  code: string;
  name: string;
  isActive?: boolean;
  displayOrder?: number;
  metadataJson?: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    const code = String(args.code ?? '').trim();
    const name = String(args.name ?? '').trim();
    if (!code) return { ok: false, error: 'Поле "Код" обязательно' };
    if (!name) return { ok: false, error: 'Поле "Название" обязательно' };

    const ts = nowMs();
    const id = String(args.id || randomUUID());

    // Uniqueness of code among non-deleted rows
    const conflicts = await db
      .select({ id: directoryWorkshops.id })
      .from(directoryWorkshops)
      .where(and(eq(directoryWorkshops.code, code), isNull(directoryWorkshops.deletedAt)))
      .limit(2);
    const conflictId = conflicts.find((row) => String(row.id) !== id)?.id;
    if (conflictId) return { ok: false, error: `Цех с кодом '${code}' уже существует` };

    if (args.id) {
      const existing = await db
        .select({ id: directoryWorkshops.id })
        .from(directoryWorkshops)
        .where(and(eq(directoryWorkshops.id, id), isNull(directoryWorkshops.deletedAt)))
        .limit(1);
      if (!existing[0]) return { ok: false, error: 'Цех для обновления не найден' };
      await db
        .update(directoryWorkshops)
        .set({
          code,
          name,
          isActive: args.isActive ?? true,
          displayOrder: Math.trunc(Number(args.displayOrder ?? 0)),
          metadataJson: args.metadataJson ?? null,
          updatedAt: ts,
        })
        .where(eq(directoryWorkshops.id, id));
    } else {
      await db.insert(directoryWorkshops).values({
        id,
        code,
        name,
        isActive: args.isActive ?? true,
        displayOrder: Math.trunc(Number(args.displayOrder ?? 0)),
        metadataJson: args.metadataJson ?? null,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteWorkshop(args: { id: string }): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id || '').trim();
    if (!id) return { ok: false, error: 'id обязателен' };
    const ts = nowMs();
    await db
      .update(directoryWorkshops)
      .set({ deletedAt: ts, deprecatedAt: ts, isActive: false, updatedAt: ts })
      .where(and(eq(directoryWorkshops.id, id), isNull(directoryWorkshops.deletedAt)));
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

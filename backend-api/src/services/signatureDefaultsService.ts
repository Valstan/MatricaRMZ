import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { entities, erpEmployeeCards, signatureDefaults } from '../database/schema.js';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type SignatureDefaultRow = {
  id: string;
  fieldKey: string;
  employeeId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/**
 * Умолчания подписей (PR-5): ключ поля подписи → сотрудник.
 * Ведёт только админская дверь (REST, роль проверяет роут) обычным
 * insert/update — мимо пути записи синхронизации. Публикатор зеркала
 * доводит строку до журнала (sync_status='pending' → seq).
 */
export async function listSignatureDefaults(): Promise<Result<{ rows: SignatureDefaultRow[] }>> {
  const rows = await db.select().from(signatureDefaults).where(isNull(signatureDefaults.deletedAt));
  return {
    ok: true,
    rows: rows.map((r) => ({
      id: String(r.id),
      fieldKey: String(r.fieldKey),
      employeeId: r.employeeId == null ? null : String(r.employeeId),
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
      deletedAt: r.deletedAt == null ? null : Number(r.deletedAt),
    })),
  };
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function setSignatureDefault(args: { fieldKey: string; employeeId: string | null }): Promise<Result<{ id: string }>> {
  const fieldKey = String(args.fieldKey ?? '').trim();
  if (!fieldKey) return { ok: false, error: 'fieldKey обязателен' };
  const employeeId = args.employeeId == null || String(args.employeeId).trim() === '' ? null : String(args.employeeId).trim();
  if (employeeId !== null) {
    if (!isUuid(employeeId)) return { ok: false, error: 'employeeId обязан быть uuid' };
    // Сотрудник обязан существовать: строгое erp_employee_cards, иначе EAV-сущность employee.
    const strict = await db
      .select({ id: erpEmployeeCards.id })
      .from(erpEmployeeCards)
      .where(and(eq(erpEmployeeCards.id, employeeId as any), isNull(erpEmployeeCards.deletedAt)))
      .limit(1);
    let exists = strict.length > 0;
    if (!exists) {
      const eav = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.id, employeeId as any), isNull(entities.deletedAt)))
        .limit(1);
      exists = eav.length > 0;
    }
    if (!exists) return { ok: false, error: 'сотрудник не существует или удалён' };
  }
  const now = Date.now();
  const existing = await db
    .select({ id: signatureDefaults.id })
    .from(signatureDefaults)
    .where(and(eq(signatureDefaults.fieldKey, fieldKey), isNull(signatureDefaults.deletedAt)))
    .limit(1);
  if (existing[0]) {
    const id = String(existing[0].id);
    await db
      .update(signatureDefaults)
      .set({ employeeId: employeeId as any, updatedAt: now, syncStatus: 'pending' })
      .where(eq(signatureDefaults.id, id as any));
    return { ok: true, id };
  }
  const id = randomUUID();
  await db.insert(signatureDefaults).values({
    id: id as any,
    fieldKey,
    employeeId: employeeId as any,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'pending',
  });
  return { ok: true, id };
}

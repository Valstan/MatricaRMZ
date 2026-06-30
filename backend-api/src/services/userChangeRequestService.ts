/**
 * User-change approval queue (RBAC #474, M4).
 *
 * Non-superadmin admins don't apply user add/edit directly — the proposed change
 * is stored as a pending request and a superadmin (later also the HR-head with
 * `employees.approve`) approves or rejects it. Reuses the generic `change_requests`
 * table with a dedicated marker tableName so it stays out of the entity-edit
 * "Изменения" module. The apply itself lives in the route (it needs the employee
 * auth services); this service is just the queue storage.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { changeRequests } from '../database/schema.js';

export const USER_CHANGE_MARKER = 'admin_user';

export const USER_CHANGE_PENDING_MESSAGE =
  'Изменения отправлены на одобрение начальнику отдела кадров и суперадминистратору. ' +
  'Дождитесь подтверждения. Для ускорения утверждения — позвоните им.';

export type UserChangeKind = 'create' | 'update';

export type UserChangePayload = {
  kind: UserChangeKind;
  // create: the full new-user fields; update: the patch fields (only changed keys)
  data: Record<string, unknown>;
};

export type UserChangeActor = { id: string; username?: string | null | undefined };

export async function submitUserChangeRequest(args: {
  actor: UserChangeActor;
  rowId: string; // target employee id (update) or the new employee id (create)
  payload: UserChangePayload;
  beforeJson?: string | null;
  note?: string | null;
}): Promise<{ ok: true; id: string; message: string }> {
  const id = randomUUID();
  await db.insert(changeRequests).values({
    id,
    status: 'pending',
    tableName: USER_CHANGE_MARKER,
    rowId: args.rowId,
    afterJson: JSON.stringify(args.payload),
    beforeJson: args.beforeJson ?? null,
    changeAuthorUserId: args.actor.id,
    changeAuthorUsername: args.actor.username || args.actor.id,
    note: args.note ?? null,
    createdAt: Date.now(),
  });
  return { ok: true, id, message: USER_CHANGE_PENDING_MESSAGE };
}

export type UserChangeRequestRow = {
  id: string;
  status: string;
  rowId: string;
  payload: UserChangePayload | null;
  beforeJson: string | null;
  changeAuthorUserId: string;
  changeAuthorUsername: string;
  note: string | null;
  createdAt: number;
};

function toRow(r: typeof changeRequests.$inferSelect): UserChangeRequestRow {
  let payload: UserChangePayload | null = null;
  try {
    payload = JSON.parse(String(r.afterJson)) as UserChangePayload;
  } catch {
    payload = null;
  }
  return {
    id: String(r.id),
    status: String(r.status),
    rowId: String(r.rowId),
    payload,
    beforeJson: r.beforeJson ?? null,
    changeAuthorUserId: String(r.changeAuthorUserId),
    changeAuthorUsername: String(r.changeAuthorUsername),
    note: r.note ?? null,
    createdAt: Number(r.createdAt),
  };
}

export async function listPendingUserChangeRequests(): Promise<UserChangeRequestRow[]> {
  const rows = await db
    .select()
    .from(changeRequests)
    .where(and(eq(changeRequests.tableName, USER_CHANGE_MARKER), eq(changeRequests.status, 'pending')))
    .orderBy(desc(changeRequests.createdAt))
    .limit(1000);
  return rows.map(toRow);
}

export async function getUserChangeRequest(id: string): Promise<UserChangeRequestRow | null> {
  const rows = await db
    .select()
    .from(changeRequests)
    .where(and(eq(changeRequests.id, id), eq(changeRequests.tableName, USER_CHANGE_MARKER)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function markUserChangeRequestDecided(args: {
  id: string;
  status: 'applied' | 'rejected';
  approver: UserChangeActor;
  note?: string | null;
}): Promise<{ ok: boolean }> {
  const set: Record<string, unknown> = {
    status: args.status,
    decidedAt: Date.now(),
    decidedByUserId: args.approver.id,
    decidedByUsername: args.approver.username || args.approver.id,
  };
  if (args.note !== undefined) set['note'] = args.note;
  const res = await db
    .update(changeRequests)
    .set(set)
    .where(and(eq(changeRequests.id, args.id), eq(changeRequests.status, 'pending')));
  // drizzle pg returns a result with rowCount on the driver; treat as best-effort
  return { ok: !!res };
}

import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { entities, entityTypes, erpContracts, erpCounterparties } from '../database/schema.js';
import { findContractInternalNumberDuplicate } from './contractNumberGuard.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

/**
 * Серверные двери записи договоров/контрагентов в строгие таблицы (план
 * contract-cutover-2026-10, шаг C1). Образец — R2 (`setEmployeeSectionAccess`):
 * договоры правят в офисе по сети, офлайн-запись им не нужна.
 *
 * Дверь принимает полевой патч (как setAttr, но strict-backed): гранулярность
 * конкурентных правок сохраняется. Неизвестное поле — громкий отказ с
 * перечислением (приём R2). Запись — напрямую в erp_* со статусом pending,
 * развозит существующий публикатор словарей (≤60 с): прямая публикация
 * server-owned таблиц отбивается backstop'ом applyPushBatch (проверено вживую).
 * entities-строки публикуются сразу (они не server-owned).
 * EAV-триггеры зеркалят старые клиенты весь переходный период; двери EAV не
 * трогают, петли нет.
 *
 * Вне скоупа двери (остаётся в EAV): `has_files`, `attachments` — файловые
 * метаданные, в strict-зеркале их нет и не было.
 */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const uuid = z.string().uuid();
const msOrNull = z.number().int().nonnegative().nullable().optional();
const textOrNull = z.string().nullable().optional();

const contractPatchSchema = z.object({
  number: textOrNull,
  internal_number: textOrNull,
  goz_name: textOrNull,
  goz_igk: textOrNull,
  goz_separate_account_number: textOrNull,
  goz_separate_account_bank: textOrNull,
  goz_separate_account: textOrNull,
  signed_at: msOrNull,
  due_at: msOrNull,
  customer_id: z.string().uuid().nullable().optional(),
  comment: textOrNull,
  sections_json: z.string().nullable().optional(),
  execution_parts_json: z.string().nullable().optional(),
});

const counterpartyPatchSchema = z.object({
  name: z.string().min(1),
  short_name: textOrNull,
  inn: textOrNull,
  kpp: textOrNull,
  address: textOrNull,
  email: textOrNull,
  phone: textOrNull,
});

type ContractPatch = z.infer<typeof contractPatchSchema>;
type CounterpartyPatch = z.infer<typeof counterpartyPatchSchema>;

const CONTRACT_PATCH_KEYS = new Set(Object.keys(contractPatchSchema.shape));
const COUNTERPARTY_PATCH_KEYS = new Set(Object.keys(counterpartyPatchSchema.shape));

function rejectUnknown(input: Record<string, unknown>, known: Set<string>, what: string): string | null {
  const bad = Object.keys(input).filter((k) => !known.has(k));
  return bad.length > 0 ? `неизвестные поля ${what}: ${bad.join(', ')}` : null;
}

function nowMs(): number {
  return Date.now();
}

async function typeIdOf(code: string): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0] ? String(rows[0].id) : null;
}

function toContractRow(r: typeof erpContracts.$inferSelect): Record<string, unknown> {
  return {
    id: String(r.id),
    number: r.number ?? null,
    internal_number: r.internalNumber ?? null,
    goz_name: r.gozName ?? null,
    goz_igk: r.gozIgk ?? null,
    goz_separate_account_number: r.gozSeparateAccountNumber ?? null,
    goz_separate_account_bank: r.gozSeparateAccountBank ?? null,
    goz_separate_account: r.gozSeparateAccount ?? null,
    signed_at: r.signedAt ?? null,
    due_at: r.dueAt ?? null,
    customer_id: r.customerId ? String(r.customerId) : null,
    comment: r.comment ?? null,
    sections_json: r.sectionsJson ?? null,
    execution_parts_json: r.executionPartsJson ?? null,
    payments_json: r.paymentsJson ?? null,
    created_at: Number(r.createdAt),
    updated_at: Number(r.updatedAt),
    deleted_at: r.deletedAt ?? null,
  };
}

function toCounterpartyRow(r: typeof erpCounterparties.$inferSelect): Record<string, unknown> {
  return {
    id: String(r.id),
    name: String(r.name),
    short_name: r.shortName ?? null,
    inn: r.inn ?? null,
    kpp: r.kpp ?? null,
    address: r.address ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    created_at: Number(r.createdAt),
    updated_at: Number(r.updatedAt),
    deleted_at: r.deletedAt ?? null,
  };
}

/** Создать договор: строгая строка + entities-строка (списки читают entities). */
export async function createContractStrict(raw: unknown, actor: PublishActor): Promise<Result<{ row: Record<string, unknown> }>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'ожидался объект полей договора' };
  const input = raw as Record<string, unknown>;
  const rejected = rejectUnknown(input, CONTRACT_PATCH_KEYS, 'договора');
  if (rejected) return { ok: false, error: rejected };
  const parsed = contractPatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `неверные поля договора: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  const id = typeof input.id === 'string' && uuid.safeParse(input.id).success ? String(input.id) : randomUUID();
  return createContractRow(id, parsed.data, actor);
}

async function createContractRow(id: string, patch: ContractPatch, actor: PublishActor): Promise<Result<{ row: Record<string, unknown> }>> {
  const dup = await findContractInternalNumberDuplicate(patch.internal_number ?? null, id);
  if (dup) return { ok: false, error: `внутренний номер занят договором ${dup.contractNumber || dup.id}` };
  if (patch.customer_id) {
    const cust = await db
      .select({ id: erpCounterparties.id })
      .from(erpCounterparties)
      .where(and(eq(erpCounterparties.id, patch.customer_id as any), isNull(erpCounterparties.deletedAt)))
      .limit(1);
    if (cust.length === 0) return { ok: false, error: 'заказчик не найден в справочнике' };
  }
  const contractTypeId = await typeIdOf('contract');
  if (!contractTypeId) return { ok: false, error: 'тип contract не найден' };
  const ts = nowMs();
  await db.insert(entities).values({ id: id as any, typeId: contractTypeId as any, createdAt: ts, updatedAt: ts, deletedAt: null, syncStatus: 'pending' } as any);
  await publish(actor, SyncTableName.Entities, id, { id, type_id: contractTypeId, created_at: ts, updated_at: ts, deleted_at: null }, ts);
  // Upsert, а не insert: entities-триггер зеркала уже мог положить shell-строку
  // («Без названия») в той же миллисекунде — дверь перезаписывает её каноном.
  const inserted = await db
    .insert(erpContracts)
    .values({
      id: id as any,
      number: patch.number ?? null,
      internalNumber: patch.internal_number ?? null,
      gozName: patch.goz_name ?? null,
      gozIgk: patch.goz_igk ?? null,
      gozSeparateAccountNumber: patch.goz_separate_account_number ?? null,
      gozSeparateAccountBank: patch.goz_separate_account_bank ?? null,
      gozSeparateAccount: patch.goz_separate_account ?? null,
      signedAt: patch.signed_at ?? null,
      dueAt: patch.due_at ?? null,
      customerId: (patch.customer_id ?? null) as any,
      comment: patch.comment ?? null,
      sectionsJson: patch.sections_json ?? null,
      executionPartsJson: patch.execution_parts_json ?? null,
      paymentsJson: null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    })
    .onConflictDoUpdate({
      target: erpContracts.id,
      set: {
        number: patch.number ?? null,
        internalNumber: patch.internal_number ?? null,
        gozName: patch.goz_name ?? null,
        gozIgk: patch.goz_igk ?? null,
        gozSeparateAccountNumber: patch.goz_separate_account_number ?? null,
        gozSeparateAccountBank: patch.goz_separate_account_bank ?? null,
        gozSeparateAccount: patch.goz_separate_account ?? null,
        signedAt: patch.signed_at ?? null,
        dueAt: patch.due_at ?? null,
        customerId: (patch.customer_id ?? null) as any,
        comment: patch.comment ?? null,
        sectionsJson: patch.sections_json ?? null,
        executionPartsJson: patch.execution_parts_json ?? null,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      },
    })
    .returning();
  const row = inserted[0];
  if (!row) return { ok: false, error: 'не удалось создать договор' };
  return { ok: true, row: toContractRow(row) };
}

/** Полевой патч договора: меняются только присланные поля, холостая запись не бампит. */
export async function patchContractStrict(
  id: string,
  raw: unknown,
  actor: PublishActor,
): Promise<Result<{ row: Record<string, unknown>; changed: boolean }>> {
  const contractId = String(id ?? '').trim();
  if (!uuid.safeParse(contractId).success) return { ok: false, error: 'неверный id договора' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'ожидался объект полей договора' };
  const input = raw as Record<string, unknown>;
  const rejected = rejectUnknown(input, CONTRACT_PATCH_KEYS, 'договора');
  if (rejected) return { ok: false, error: rejected };
  const parsed = contractPatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `неверные поля договора: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  const patch = parsed.data;
  const existing = await db.select().from(erpContracts).where(eq(erpContracts.id, contractId as any)).limit(1);
  const cur = existing[0];
  if (!cur || cur.deletedAt != null) return { ok: false, error: 'договор не найден' };
  if (patch.internal_number !== undefined) {
    const dup = await findContractInternalNumberDuplicate(patch.internal_number, contractId);
    if (dup) return { ok: false, error: `внутренний номер занят договором ${dup.contractNumber || dup.id}` };
  }
  if (patch.customer_id !== undefined && patch.customer_id !== null) {
    const cust = await db
      .select({ id: erpCounterparties.id })
      .from(erpCounterparties)
      .where(and(eq(erpCounterparties.id, patch.customer_id as any), isNull(erpCounterparties.deletedAt)))
      .limit(1);
    if (cust.length === 0) return { ok: false, error: 'заказчик не найден в справочнике' };
  }
  const ts = nowMs();
  const set = {
    ...(patch.number !== undefined ? { number: patch.number ?? null } : {}),
    ...(patch.internal_number !== undefined ? { internalNumber: patch.internal_number ?? null } : {}),
    ...(patch.goz_name !== undefined ? { gozName: patch.goz_name ?? null } : {}),
    ...(patch.goz_igk !== undefined ? { gozIgk: patch.goz_igk ?? null } : {}),
    ...(patch.goz_separate_account_number !== undefined ? { gozSeparateAccountNumber: patch.goz_separate_account_number ?? null } : {}),
    ...(patch.goz_separate_account_bank !== undefined ? { gozSeparateAccountBank: patch.goz_separate_account_bank ?? null } : {}),
    ...(patch.goz_separate_account !== undefined ? { gozSeparateAccount: patch.goz_separate_account ?? null } : {}),
    ...(patch.signed_at !== undefined ? { signedAt: patch.signed_at ?? null } : {}),
    ...(patch.due_at !== undefined ? { dueAt: patch.due_at ?? null } : {}),
    ...(patch.customer_id !== undefined ? { customerId: (patch.customer_id ?? null) as any } : {}),
    ...(patch.comment !== undefined ? { comment: patch.comment ?? null } : {}),
    ...(patch.sections_json !== undefined ? { sectionsJson: patch.sections_json ?? null } : {}),
    ...(patch.execution_parts_json !== undefined ? { executionPartsJson: patch.execution_parts_json ?? null } : {}),
  };
  if (Object.keys(set).length === 0) return { ok: true, row: toContractRow(cur), changed: false };
  const updated = await db
    .update(erpContracts)
    .set({ ...set, updatedAt: ts, syncStatus: 'pending' })
    .where(eq(erpContracts.id, contractId as any))
    .returning();
  const row = updated[0];
  if (!row) return { ok: false, error: 'не удалось сохранить договор' };
  return { ok: true, row: toContractRow(row), changed: true };
}

export async function getContractStrict(id: string): Promise<Result<{ row: Record<string, unknown> }>> {
  const contractId = String(id ?? '').trim();
  if (!uuid.safeParse(contractId).success) return { ok: false, error: 'неверный id договора' };
  const rows = await db.select().from(erpContracts).where(eq(erpContracts.id, contractId as any)).limit(1);
  const row = rows[0];
  if (!row || row.deletedAt != null) return { ok: false, error: 'договор не найден' };
  return { ok: true, row: toContractRow(row) };
}

/** Создать контрагента: строгая строка + entities-строка. */
export async function createCounterpartyStrict(raw: unknown, actor: PublishActor): Promise<Result<{ row: Record<string, unknown> }>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'ожидался объект полей контрагента' };
  const input = raw as Record<string, unknown>;
  const rejected = rejectUnknown(input, COUNTERPARTY_PATCH_KEYS, 'контрагента');
  if (rejected) return { ok: false, error: rejected };
  const parsed = counterpartyPatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `неверные поля контрагента: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  const id = typeof input.id === 'string' && uuid.safeParse(input.id).success ? String(input.id) : randomUUID();
  const customerTypeId = await typeIdOf('customer');
  if (!customerTypeId) return { ok: false, error: 'тип customer не найден' };
  const ts = nowMs();
  await db.insert(entities).values({ id: id as any, typeId: customerTypeId as any, createdAt: ts, updatedAt: ts, deletedAt: null, syncStatus: 'pending' } as any);
  await publish(actor, SyncTableName.Entities, id, { id, type_id: customerTypeId, created_at: ts, updated_at: ts, deleted_at: null }, ts);
  // Upsert: entities-триггер уже мог положить shell-строку — см. createContractRow.
  const inserted = await db
    .insert(erpCounterparties)
    .values({
      id: id as any,
      name: parsed.data.name,
      shortName: parsed.data.short_name ?? null,
      inn: parsed.data.inn ?? null,
      kpp: parsed.data.kpp ?? null,
      address: parsed.data.address ?? null,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    })
    .onConflictDoUpdate({
      target: erpCounterparties.id,
      set: {
        name: parsed.data.name,
        shortName: parsed.data.short_name ?? null,
        inn: parsed.data.inn ?? null,
        kpp: parsed.data.kpp ?? null,
        address: parsed.data.address ?? null,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      },
    })
    .returning();
  const row = inserted[0];
  if (!row) return { ok: false, error: 'не удалось создать контрагента' };
  return { ok: true, row: toCounterpartyRow(row) };
}

export async function patchCounterpartyStrict(
  id: string,
  raw: unknown,
  actor: PublishActor,
): Promise<Result<{ row: Record<string, unknown>; changed: boolean }>> {
  const counterpartyId = String(id ?? '').trim();
  if (!uuid.safeParse(counterpartyId).success) return { ok: false, error: 'неверный id контрагента' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'ожидался объект полей контрагента' };
  const input = raw as Record<string, unknown>;
  const rejected = rejectUnknown(input, COUNTERPARTY_PATCH_KEYS, 'контрагента');
  if (rejected) return { ok: false, error: rejected };
  // name обязателен при создании; в патче — опционален.
  const patchSchema = counterpartyPatchSchema.partial();
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `неверные поля контрагента: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  const patch = parsed.data;
  const existing = await db.select().from(erpCounterparties).where(eq(erpCounterparties.id, counterpartyId as any)).limit(1);
  const cur = existing[0];
  if (!cur || cur.deletedAt != null) return { ok: false, error: 'контрагент не найден' };
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.short_name !== undefined ? { shortName: patch.short_name ?? null } : {}),
    ...(patch.inn !== undefined ? { inn: patch.inn ?? null } : {}),
    ...(patch.kpp !== undefined ? { kpp: patch.kpp ?? null } : {}),
    ...(patch.address !== undefined ? { address: patch.address ?? null } : {}),
    ...(patch.email !== undefined ? { email: patch.email ?? null } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone ?? null } : {}),
  };
  if (Object.keys(set).length === 0) return { ok: true, row: toCounterpartyRow(cur), changed: false };
  const ts = nowMs();
  const updated = await db
    .update(erpCounterparties)
    .set({ ...set, updatedAt: ts, syncStatus: 'pending' })
    .where(eq(erpCounterparties.id, counterpartyId as any))
    .returning();
  const row = updated[0];
  if (!row) return { ok: false, error: 'не удалось сохранить контрагента' };
  return { ok: true, row: toCounterpartyRow(row), changed: true };
}

export async function getCounterpartyStrict(id: string): Promise<Result<{ row: Record<string, unknown> }>> {
  const counterpartyId = String(id ?? '').trim();
  if (!uuid.safeParse(counterpartyId).success) return { ok: false, error: 'неверный id контрагента' };
  const rows = await db.select().from(erpCounterparties).where(eq(erpCounterparties.id, counterpartyId as any)).limit(1);
  const row = rows[0];
  if (!row || row.deletedAt != null) return { ok: false, error: 'контрагент не найден' };
  return { ok: true, row: toCounterpartyRow(row) };
}

type PublishActor = { id: string; username: string; role?: string };

/** Немедленная публикация строки в журнал (двери пишут мимо EAV-пути — без этого pull не увидит). */
async function publish(
  actor: PublishActor,
  table: SyncTableName,
  rowId: string,
  payload: Record<string, unknown>,
  ts: number,
): Promise<void> {
  await recordSyncChanges(
    { id: actor.id, username: actor.username, role: actor.role ?? 'admin' },
    [{ tableName: table, rowId, op: (payload as { deleted_at?: number | null }).deleted_at ? 'delete' : 'upsert', payload, ts }],
  );
}

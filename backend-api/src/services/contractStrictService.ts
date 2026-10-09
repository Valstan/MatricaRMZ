import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { SyncTableName, contractInternalNumberKey } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { entities, entityTypes, erpContracts, erpCounterparties } from '../database/schema.js';
import { setEntityAttribute } from './adminMasterdataService.js';
import { findContractInternalNumberDuplicate } from './contractNumberGuard.js';
import { recordSyncChanges } from './sync/syncChangeService.js';
import { logWarn } from '../utils/logger.js';

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

const CONTRACT_PATCH_KEYS = new Set(Object.keys(contractPatchSchema.shape));
const COUNTERPARTY_PATCH_KEYS = new Set(Object.keys(counterpartyPatchSchema.shape));

// Создание несёт `id` от клиента (deferred-create: карточка открывается на сгенерированном
// uuid до первой записи), поэтому create-схемы его разрешают — иначе любой create падал
// на «неизвестные поля» до разбора (баг 09.10.2026). В patch `id` по-прежнему чужой.
const contractCreateSchema = contractPatchSchema.extend({ id: uuid.optional() });
const counterpartyCreateSchema = counterpartyPatchSchema.extend({ id: uuid.optional() });
const CONTRACT_CREATE_KEYS = new Set(Object.keys(contractCreateSchema.shape));
const COUNTERPARTY_CREATE_KEYS = new Set(Object.keys(counterpartyCreateSchema.shape));

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

/**
 * EAV-след двери (переходный период): старые клиенты читают EAV, и правка
 * нового клиента обязана быть видна им сразу, а не после их обновления.
 * Пишем те же значения теми же кодами, что карточка писала всегда; сериализация
 * — тот же JSON.stringify того же объекта, поэтому триггер зеркала видит
 * равенство и не устраивает шторм перезаписей. Отказ следа — только warn:
 * канон уже записан выше, EAV догонит следующим pull/push.
 */
async function writeEavTrail(
  actor: PublishActor,
  entityId: string,
  entries: Array<[code: string, value: unknown]>,
): Promise<void> {
  for (const [code, value] of entries) {
    try {
      const r = await setEntityAttribute(
        { id: actor.id, username: actor.username },
        entityId,
        code,
        value,
        { allowSyncConflicts: true },
      );
      if (!r.ok) logWarn('contract door EAV trail rejected', { entityId, code, error: r.error });
    } catch (e) {
      logWarn('contract door EAV trail failed', { entityId, code, error: String(e) });
    }
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Поле исполнения договора — МАСИВ строк (`ContractExecutionPartRow[]`, клиент шлёт
 * `JSON.stringify(normalizeContractExecutionParts(...))`, пустой — `"[]"`).
 * Дверь требовала здесь объект тем же `parseJsonObject` — и резала ЛЮБОЙ
 * execution_parts_json, то есть не сохранялся ни один новый договор без
 * исполнения (баг 10.10.2026: «неверный execution_parts_json» на создании).
 */
function parseJsonArray(raw: string | null | undefined): unknown[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Пустое/«null»-строковое JSON-поле — как отсутствующее. Клиенты парка за пусто
 * шлют `"null"`/`""` (баг 10.10.2026: создание договора упиралось в
 * «неверный execution_parts_json»); резать их ошибкой — значит блокировать
 * сохранение из-за ничего.
 */
function emptyJsonToNull(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  return t === '' || t === 'null' ? null : raw;
}

/**
 * Канонический текст JSON — ровно тот, что положит зеркало: `eav_attr_text`
 * нормализует через `::jsonb #>> '{}'` (сортировка ключей, пробелы). Дверь обязана
 * писать strict в той же сериализации, иначе триггер увидит «изменение» на каждой
 * правке и перепишет строку штормом (проверено вживую). Реимплементация нормализации
 * в TS хрупка — спрашиваем сам PG (один дешёвый запрос).
 */
async function jsonbCanonicalText(obj: Record<string, unknown> | unknown[]): Promise<string> {
  const res = await db.execute(sql`select ${JSON.stringify(obj)}::jsonb #>> '{}' as t`);
  const rows = res.rows as Array<{ t: string }>;
  if (!rows[0]) throw new Error('jsonb normalize returned no rows');
  return String(rows[0].t);
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
  const rejected = rejectUnknown(input, CONTRACT_CREATE_KEYS, 'договора');
  if (rejected) return { ok: false, error: rejected };
  const parsed = contractCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `неверные поля договора: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  const id = parsed.data.id ?? randomUUID();
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
  // Канонические JSON: один объект — одна сериализация и в strict, и в EAV-след,
  // иначе триггер зеркала увидит «изменение» и перепишет strict штормом.
  const sectionsRaw = emptyJsonToNull(patch.sections_json);
  const sections = sectionsRaw != null ? parseJsonObject(sectionsRaw) : null;
  if (sectionsRaw != null && !sections) return { ok: false, error: 'неверный sections_json' };
  const execPartsRaw = emptyJsonToNull(patch.execution_parts_json);
  const execParts = execPartsRaw != null ? parseJsonArray(execPartsRaw) : null;
  if (execPartsRaw != null && !execParts) return { ok: false, error: 'неверный execution_parts_json' };
  const sectionsText = sections ? await jsonbCanonicalText(sections) : null;
  const execPartsText = execParts ? await jsonbCanonicalText(execParts) : null;
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
      sectionsJson: sectionsText,
      executionPartsJson: execPartsText,
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
        sectionsJson: sectionsText,
        executionPartsJson: execPartsText,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      },
    })
    .returning();
  const row = inserted[0];
  if (!row) return { ok: false, error: 'не удалось создать договор' };
  // След — только по присланным полям: отсутствующее поле в EAV означает «нет
  // значения», а не null-строку (иначе каждая карточка обрастала бы дюжиной
  // пустых атрибутов).
  const trail: Array<[string, unknown]> = [];
  if (patch.number !== undefined) trail.push(['number', patch.number ?? null]);
  if (patch.internal_number !== undefined) trail.push(['internal_number', patch.internal_number ?? null]);
  if (patch.goz_name !== undefined) trail.push(['goz_name', patch.goz_name ?? null]);
  if (patch.goz_igk !== undefined) trail.push(['goz_igk', patch.goz_igk ?? null]);
  if (patch.goz_separate_account_number !== undefined) trail.push(['goz_separate_account_number', patch.goz_separate_account_number ?? null]);
  if (patch.goz_separate_account_bank !== undefined) trail.push(['goz_separate_account_bank', patch.goz_separate_account_bank ?? null]);
  if (patch.goz_separate_account !== undefined) trail.push(['goz_separate_account', patch.goz_separate_account ?? null]);
  if (patch.signed_at !== undefined) trail.push(['date', patch.signed_at ?? null]);
  if (patch.due_at !== undefined) trail.push(['due_date', patch.due_at ?? null]);
  if (patch.customer_id !== undefined) trail.push(['customer_id', patch.customer_id ?? null]);
  if (patch.comment !== undefined) trail.push(['comment', patch.comment ?? null]);
  if (sections) trail.push(['contract_sections', sections]);
  if (execParts) trail.push(['contract_execution_parts', execParts]);
  await writeEavTrail(actor, id, trail);
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
    // Пересохранение неизменного номера разрешено: на проде живут три разных
    // договора с одним номером (решение владельца 2026-10-03), иначе их карточки
    // не сохранялись бы вовсе. Новые дубли по-прежнему блокируются.
    const prevKey = contractInternalNumberKey(cur.internalNumber);
    const nextKey = contractInternalNumberKey(patch.internal_number);
    if (nextKey && nextKey !== prevKey) {
      const dup = await findContractInternalNumberDuplicate(patch.internal_number, contractId);
      if (dup) return { ok: false, error: `внутренний номер занят договором ${dup.contractNumber || dup.id}` };
    }
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
  const sectionsRaw = patch.sections_json !== undefined ? emptyJsonToNull(patch.sections_json) : undefined;
  const sections = sectionsRaw !== undefined
    ? sectionsRaw == null ? null : parseJsonObject(sectionsRaw)
    : undefined;
  if (sectionsRaw !== undefined && sectionsRaw != null && !sections) {
    return { ok: false, error: 'неверный sections_json' };
  }
  const execPartsRaw = patch.execution_parts_json !== undefined ? emptyJsonToNull(patch.execution_parts_json) : undefined;
  const execParts = execPartsRaw !== undefined
    ? execPartsRaw == null ? null : parseJsonArray(execPartsRaw)
    : undefined;
  if (execPartsRaw !== undefined && execPartsRaw != null && !execParts) {
    return { ok: false, error: 'неверный execution_parts_json' };
  }
  const sectionsText = sections ? await jsonbCanonicalText(sections) : sections === null ? null : undefined;
  const execPartsText = execParts ? await jsonbCanonicalText(execParts) : execParts === null ? null : undefined;
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
    ...(sectionsText !== undefined ? { sectionsJson: sectionsText } : {}),
    ...(execPartsText !== undefined ? { executionPartsJson: execPartsText } : {}),
  };
  if (Object.keys(set).length === 0) return { ok: true, row: toContractRow(cur), changed: false };
  const updated = await db
    .update(erpContracts)
    .set({ ...set, updatedAt: ts, syncStatus: 'pending' })
    .where(eq(erpContracts.id, contractId as any))
    .returning();
  const row = updated[0];
  if (!row) return { ok: false, error: 'не удалось сохранить договор' };
  await writeEavTrail(actor, contractId, trailOf(patch, sections, execParts));
  return { ok: true, row: toContractRow(row), changed: true };
}

/** EAV-след полевого патча: те же коды, что карточка писала всегда. */
function trailOf(
  patch: ContractPatch,
  sections: Record<string, unknown> | null | undefined,
  execParts: Record<string, unknown> | unknown[] | null | undefined,
): Array<[string, unknown]> {
  const trail: Array<[string, unknown]> = [];
  if (patch.number !== undefined) trail.push(['number', patch.number ?? null]);
  if (patch.internal_number !== undefined) trail.push(['internal_number', patch.internal_number ?? null]);
  if (patch.goz_name !== undefined) trail.push(['goz_name', patch.goz_name ?? null]);
  if (patch.goz_igk !== undefined) trail.push(['goz_igk', patch.goz_igk ?? null]);
  if (patch.goz_separate_account_number !== undefined) trail.push(['goz_separate_account_number', patch.goz_separate_account_number ?? null]);
  if (patch.goz_separate_account_bank !== undefined) trail.push(['goz_separate_account_bank', patch.goz_separate_account_bank ?? null]);
  if (patch.goz_separate_account !== undefined) trail.push(['goz_separate_account', patch.goz_separate_account ?? null]);
  if (patch.signed_at !== undefined) trail.push(['date', patch.signed_at ?? null]);
  if (patch.due_at !== undefined) trail.push(['due_date', patch.due_at ?? null]);
  if (patch.customer_id !== undefined) trail.push(['customer_id', patch.customer_id ?? null]);
  if (patch.comment !== undefined) trail.push(['comment', patch.comment ?? null]);
  if (sections !== undefined) trail.push(['contract_sections', sections]);
  if (execParts !== undefined) trail.push(['contract_execution_parts', execParts]);
  return trail;
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
  const rejected = rejectUnknown(input, COUNTERPARTY_CREATE_KEYS, 'контрагента');
  if (rejected) return { ok: false, error: rejected };
  const parsed = counterpartyCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `неверные поля контрагента: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  const id = parsed.data.id ?? randomUUID();
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
  await writeEavTrail(actor, id, [
    ['name', parsed.data.name],
    ...(parsed.data.short_name !== undefined ? [['short_name', parsed.data.short_name ?? null] as [string, unknown]] : []),
    ...(parsed.data.inn !== undefined ? [['inn', parsed.data.inn ?? null] as [string, unknown]] : []),
    ...(parsed.data.kpp !== undefined ? [['kpp', parsed.data.kpp ?? null] as [string, unknown]] : []),
    ...(parsed.data.address !== undefined ? [['address', parsed.data.address ?? null] as [string, unknown]] : []),
    ...(parsed.data.email !== undefined ? [['email', parsed.data.email ?? null] as [string, unknown]] : []),
    ...(parsed.data.phone !== undefined ? [['phone', parsed.data.phone ?? null] as [string, unknown]] : []),
  ]);
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
  const trail: Array<[string, unknown]> = [];
  if (patch.name !== undefined) trail.push(['name', patch.name]);
  if (patch.short_name !== undefined) trail.push(['short_name', patch.short_name ?? null]);
  if (patch.inn !== undefined) trail.push(['inn', patch.inn ?? null]);
  if (patch.kpp !== undefined) trail.push(['kpp', patch.kpp ?? null]);
  if (patch.address !== undefined) trail.push(['address', patch.address ?? null]);
  if (patch.email !== undefined) trail.push(['email', patch.email ?? null]);
  if (patch.phone !== undefined) trail.push(['phone', patch.phone ?? null]);
  await writeEavTrail(actor, counterpartyId, trail);
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

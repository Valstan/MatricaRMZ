import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { parseProductionProgramState } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { erpProductionProgramRows, erpProductionPrograms } from '../database/schema.js';

/**
 * Производственная программа (ПП) — серверная дверь.
 *
 * Модуль плана производства на две недели/месяц по Word-форме «ПП Цех № 1»
 * (план `docs/plans/proizvodstvennaya-programma-2026-11.md`).
 *
 * Ведёт ТОЛЬКО эта дверь: строки пишутся обычным insert/update с
 * `sync_status = 'pending'`, а публикатор зеркала (`productionProgramSyncPublisherService`)
 * доводит их до журнала — иначе инкрементальный pull их не увидит никогда.
 * Клиент план только читает (реплика), владение таблиц — `shared/domain/ledgerAuthz`.
 */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type ProductionProgramRow = {
  id: string;
  periodStart: number;
  periodEnd: number;
  shop: string;
  title: string;
  status: string;
  signatureSlots: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type ProductionProgramLineRow = {
  id: string;
  programId: string;
  orderNo: number;
  contractId: string | null;
  groupLabel: string;
  contractKind: string | null;
  engineId: string | null;
  engineMark: string;
  engineNumber: string;
  state: string | null;
  shippingPlanAt: number | null;
  factors: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/** Проверенная шапка плана — все поля заполнены. */
type ValidatedProgram = {
  periodStart: number;
  periodEnd: number;
  shop: string;
  title: string;
  status: string;
  signatureSlots: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function mapProgram(r: typeof erpProductionPrograms.$inferSelect): ProductionProgramRow {
  return {
    id: String(r.id),
    periodStart: Number(r.periodStart),
    periodEnd: Number(r.periodEnd),
    shop: String(r.shop),
    title: String(r.title),
    status: String(r.status),
    signatureSlots: r.signatureSlots == null ? null : String(r.signatureSlots),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    deletedAt: r.deletedAt == null ? null : Number(r.deletedAt),
  };
}

function mapLine(r: typeof erpProductionProgramRows.$inferSelect): ProductionProgramLineRow {
  return {
    id: String(r.id),
    programId: String(r.programId),
    orderNo: Number(r.orderNo),
    contractId: r.contractId == null ? null : String(r.contractId),
    groupLabel: String(r.groupLabel),
    contractKind: r.contractKind == null ? null : String(r.contractKind),
    engineId: r.engineId == null ? null : String(r.engineId),
    engineMark: String(r.engineMark),
    engineNumber: String(r.engineNumber),
    state: r.state == null ? null : String(r.state),
    shippingPlanAt: r.shippingPlanAt == null ? null : Number(r.shippingPlanAt),
    factors: String(r.factors),
    note: String(r.note),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    deletedAt: r.deletedAt == null ? null : Number(r.deletedAt),
  };
}

/** Все планы (живые) и их строки — плану одного периода одного цеха. */
export async function listProductionPrograms(): Promise<
  Result<{ rows: ProductionProgramRow[]; lines: ProductionProgramLineRow[] }>
> {
  const programs = await db
    .select()
    .from(erpProductionPrograms)
    .where(isNull(erpProductionPrograms.deletedAt))
    .orderBy(asc(erpProductionPrograms.periodStart), asc(erpProductionPrograms.createdAt));
  const ids = programs.map((p) => String(p.id));
  const lines =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(erpProductionProgramRows)
          .where(
            and(inArray(erpProductionProgramRows.programId, ids as any), isNull(erpProductionProgramRows.deletedAt)),
          )
          .orderBy(asc(erpProductionProgramRows.orderNo));
  return { ok: true, rows: programs.map(mapProgram), lines: lines.map(mapLine) };
}

export async function getProductionProgram(id: string): Promise<Result<{ row: ProductionProgramRow; lines: ProductionProgramLineRow[] }>> {
  const programId = String(id ?? '').trim();
  if (!isUuid(programId)) return { ok: false, error: 'id программы должен быть uuid' };
  const [program] = await db
    .select()
    .from(erpProductionPrograms)
    .where(and(eq(erpProductionPrograms.id, programId as any), isNull(erpProductionPrograms.deletedAt)))
    .limit(1);
  if (!program) return { ok: false, error: 'программа не найдена' };
  const lines = await db
    .select()
    .from(erpProductionProgramRows)
    .where(and(eq(erpProductionProgramRows.programId, programId as any), isNull(erpProductionProgramRows.deletedAt)))
    .orderBy(asc(erpProductionProgramRows.orderNo));
  return { ok: true, row: mapProgram(program), lines: lines.map(mapLine) };
}

export type ProductionProgramInput = {
  periodStart: number;
  periodEnd: number;
  shop: string;
  title: string;
  status?: string | undefined;
  signatureSlots?: string | null | undefined;
};

/** Правка шапки: приходят только изменённые поля. */
export type ProductionProgramUpdateInput = {
  periodStart?: number | undefined;
  periodEnd?: number | undefined;
  shop?: string | undefined;
  title?: string | undefined;
  status?: string | undefined;
  signatureSlots?: string | null | undefined;
};

/** Черновик строки плана — как приходит от редактора (частично заполненная). */
export type ProductionProgramLineDraft = {
  id?: string | null | undefined;
  orderNo?: number | undefined;
  contractId?: string | null | undefined;
  groupLabel?: string | undefined;
  contractKind?: string | null | undefined;
  engineId?: string | null | undefined;
  engineMark?: string | undefined;
  engineNumber?: string | undefined;
  state?: string | null | undefined;
  shippingPlanAt?: number | null | undefined;
  factors?: string | undefined;
  note?: string | undefined;
};

/** Проверенная строка плана — все поля заполнены. */
export type ProductionProgramLineInput = {
  id: string | null;
  orderNo: number;
  contractId: string | null;
  groupLabel: string;
  contractKind: string | null;
  engineId: string | null;
  engineMark: string;
  engineNumber: string;
  state: string | null;
  shippingPlanAt: number | null;
  factors: string;
  note: string;
};

function validateProgramInput(args: ProductionProgramInput): Result<ValidatedProgram> {
  const periodStart = Number(args.periodStart);
  const periodEnd = Number(args.periodEnd);
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd)) return { ok: false, error: 'период плана должен быть числами (мс)' };
  if (periodEnd < periodStart) return { ok: false, error: 'конец периода раньше начала' };
  const shop = String(args.shop ?? '').trim();
  if (!shop) return { ok: false, error: 'цех обязателен' };
  const title = String(args.title ?? '').trim();
  if (!title) return { ok: false, error: 'название обязательно' };
  const status = String(args.status ?? 'draft').trim() || 'draft';
  if (status !== 'draft' && status !== 'approved') return { ok: false, error: 'статус плана: draft или approved' };
  const signatureSlots = args.signatureSlots == null ? null : String(args.signatureSlots);
  if (signatureSlots !== null && signatureSlots.trim()) {
    try {
      const parsed = JSON.parse(signatureSlots);
      if (!Array.isArray(parsed)) return { ok: false, error: 'подписи должны быть списком' };
    } catch {
      return { ok: false, error: 'подписи должны быть JSON-массивом' };
    }
  }
  return { ok: true, periodStart, periodEnd, shop, title, status, signatureSlots };
}

export async function createProductionProgram(args: ProductionProgramInput): Promise<Result<{ id: string }>> {
  const checked = validateProgramInput(args);
  if (!checked.ok) return checked;
  const now = Date.now();
  const id = randomUUID();
  await db.insert(erpProductionPrograms).values({
    id: id as any,
    periodStart: checked.periodStart,
    periodEnd: checked.periodEnd,
    shop: checked.shop,
    title: checked.title,
    status: checked.status,
    signatureSlots: checked.signatureSlots,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'pending',
  });
  return { ok: true, id };
}

export async function updateProductionProgram(
  id: string,
  args: ProductionProgramUpdateInput,
): Promise<Result<{ id: string }>> {
  const programId = String(id ?? '').trim();
  if (!isUuid(programId)) return { ok: false, error: 'id программы должен быть uuid' };
  const [current] = await db
    .select()
    .from(erpProductionPrograms)
    .where(and(eq(erpProductionPrograms.id, programId as any), isNull(erpProductionPrograms.deletedAt)))
    .limit(1);
  if (!current) return { ok: false, error: 'программа не найдена' };
  const merged: ProductionProgramInput = {
    periodStart: args.periodStart ?? Number(current.periodStart),
    periodEnd: args.periodEnd ?? Number(current.periodEnd),
    shop: args.shop ?? String(current.shop),
    title: args.title ?? String(current.title),
    status: args.status ?? String(current.status),
    signatureSlots: args.signatureSlots === undefined ? (current.signatureSlots == null ? null : String(current.signatureSlots)) : args.signatureSlots,
  };
  const checked = validateProgramInput(merged);
  if (!checked.ok) return checked;
  await db
    .update(erpProductionPrograms)
    .set({
      periodStart: checked.periodStart,
      periodEnd: checked.periodEnd,
      shop: checked.shop,
      title: checked.title,
      status: checked.status,
      signatureSlots: checked.signatureSlots,
      updatedAt: Date.now(),
      syncStatus: 'pending',
    })
    .where(eq(erpProductionPrograms.id, programId as any));
  return { ok: true, id: programId };
}

/** Снятие плана: шапка и строки уходят мягко (клиент увидит удаление через зеркало). */
export async function deleteProductionProgram(id: string): Promise<Result<{ id: string }>> {
  const programId = String(id ?? '').trim();
  if (!isUuid(programId)) return { ok: false, error: 'id программы должен быть uuid' };
  const [current] = await db
    .select({ id: erpProductionPrograms.id })
    .from(erpProductionPrograms)
    .where(and(eq(erpProductionPrograms.id, programId as any), isNull(erpProductionPrograms.deletedAt)))
    .limit(1);
  if (!current) return { ok: false, error: 'программа не найдена' };
  const now = Date.now();
  await db
    .update(erpProductionPrograms)
    .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
    .where(eq(erpProductionPrograms.id, programId as any));
  await db
    .update(erpProductionProgramRows)
    .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
    .where(and(eq(erpProductionProgramRows.programId, programId as any), isNull(erpProductionProgramRows.deletedAt)));
  return { ok: true, id: programId };
}

function validateLine(input: ProductionProgramLineDraft, index: number): Result<ProductionProgramLineInput> {
  const orderNo = Number(input.orderNo);
  if (!Number.isFinite(orderNo) || orderNo <= 0) return { ok: false, error: `строка ${index + 1}: № п/п должен быть положительным числом` };
  const groupLabel = String(input.groupLabel ?? '').trim();
  if (!groupLabel) return { ok: false, error: `строка ${index + 1}: шапка группы (организация и договор) обязательна` };
  const contractId = input.contractId == null || String(input.contractId).trim() === '' ? null : String(input.contractId).trim();
  if (contractId !== null && !isUuid(contractId)) return { ok: false, error: `строка ${index + 1}: договор должен быть uuid` };
  const engineId = input.engineId == null || String(input.engineId).trim() === '' ? null : String(input.engineId).trim();
  if (engineId !== null && !isUuid(engineId)) return { ok: false, error: `строка ${index + 1}: двигатель должен быть uuid` };
  const contractKind = input.contractKind == null || String(input.contractKind).trim() === '' ? null : String(input.contractKind).trim();
  if (contractKind !== null && contractKind !== 'military' && contractKind !== 'civil') {
    return { ok: false, error: `строка ${index + 1}: вид договора — military или civil` };
  }
  const stateRaw = input.state == null || String(input.state).trim() === '' ? null : String(input.state).trim();
  if (stateRaw !== null && parseProductionProgramState(stateRaw) === null) {
    return { ok: false, error: `строка ${index + 1}: состояние — restoration, repairable или capital_repair` };
  }
  const shippingPlanAt = input.shippingPlanAt == null ? null : Number(input.shippingPlanAt);
  if (shippingPlanAt !== null && !Number.isFinite(shippingPlanAt)) {
    return { ok: false, error: `строка ${index + 1}: плановая отгрузка должна быть числом (мс)` };
  }
  return {
    ok: true,
    id: input.id == null || String(input.id).trim() === '' ? null : String(input.id).trim(),
    orderNo,
    contractId,
    groupLabel,
    contractKind,
    engineId,
    engineMark: String(input.engineMark ?? ''),
    engineNumber: String(input.engineNumber ?? ''),
    state: stateRaw,
    shippingPlanAt,
    factors: String(input.factors ?? ''),
    note: String(input.note ?? ''),
  };
}

/**
 * Полная замена строк плана: план — один документ, редактор отправляет его целиком.
 *
 * Строки с известным id обновляются на месте (id стабилен — реплика клиента не
 * плодит мусор), новые вставляются, пропавшие снимаются мягко. Порядок № п/п
 * перенумеровывается по позиции в массиве.
 */
export async function replaceProductionProgramRows(
  programId: string,
  inputs: ProductionProgramLineDraft[],
): Promise<Result<{ count: number }>> {
  const pid = String(programId ?? '').trim();
  if (!isUuid(pid)) return { ok: false, error: 'id программы должен быть uuid' };
  const [program] = await db
    .select({ id: erpProductionPrograms.id })
    .from(erpProductionPrograms)
    .where(and(eq(erpProductionPrograms.id, pid as any), isNull(erpProductionPrograms.deletedAt)))
    .limit(1);
  if (!program) return { ok: false, error: 'программа не найдена' };

  const checked: ProductionProgramLineInput[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const row = validateLine(inputs[i] ?? {}, i);
    if (!row.ok) return row;
    checked.push(row);
  }

  const existing = await db
    .select()
    .from(erpProductionProgramRows)
    .where(and(eq(erpProductionProgramRows.programId, pid as any), isNull(erpProductionProgramRows.deletedAt)));
  const existingById = new Map(existing.map((r) => [String(r.id), r]));
  const now = Date.now();
  const keptIds = new Set<string>();

  for (let i = 0; i < checked.length; i++) {
    const row = checked[i]!;
    const orderNo = i + 1;
    const id = row.id && existingById.has(String(row.id)) ? String(row.id) : randomUUID();
    if (id) keptIds.add(id);
    const values = {
      programId: pid,
      orderNo,
      contractId: row.contractId,
      groupLabel: row.groupLabel,
      contractKind: row.contractKind,
      engineId: row.engineId,
      engineMark: row.engineMark,
      engineNumber: row.engineNumber,
      state: row.state,
      shippingPlanAt: row.shippingPlanAt,
      factors: row.factors,
      note: row.note,
      updatedAt: now,
      syncStatus: 'pending',
    };
    if (existingById.has(id)) {
      await db.update(erpProductionProgramRows).set(values).where(eq(erpProductionProgramRows.id, id as any));
    } else {
      await db.insert(erpProductionProgramRows).values({ id: id as any, createdAt: now, ...values });
    }
  }

  for (const row of existing) {
    const id = String(row.id);
    if (keptIds.has(id)) continue;
    await db
      .update(erpProductionProgramRows)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(eq(erpProductionProgramRows.id, id as any));
  }

  await db
    .update(erpProductionPrograms)
    .set({ updatedAt: now, syncStatus: 'pending' })
    .where(eq(erpProductionPrograms.id, pid as any));

  return { ok: true, count: checked.length };
}

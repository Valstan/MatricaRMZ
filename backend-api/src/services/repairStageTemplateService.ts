import { and, asc, eq, isNull, like, ne } from 'drizzle-orm';

import { SyncTableName, WORK_SHEET_CODE_RE, type RepairStageTemplate } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { operations, repairStageTemplates } from '../database/schema.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

/**
 * Шаблон единого списка этапов (план unified-repair-stages, шаг 5a).
 * Живёт только на сервере, как work_sheet_types: клиент ходит по REST.
 * Код у существующего этапа не меняется (на него ссылаются stage-строки).
 */

// Шаг 8 плана: 'obkatkaRow' убран — создание строк этапов работ закрыто, и
// источник «Строка обкатки» не может сработать (миграция 0101 гасит badge в БД).
// Остались кнопки, чья автоматика проведена кодом: дефектовка и комплектность.
const AUTO_FROM = ['defectAct', 'kittingAct'] as const;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function parseAutoFrom(raw: unknown): string | null {
  const v = text(raw);
  if (!v) return null;
  return (AUTO_FROM as readonly string[]).includes(v) ? v : null;
}

export function rowToRepairStageTemplate(row: typeof repairStageTemplates.$inferSelect): RepairStageTemplate {
  const out: RepairStageTemplate = {
    code: String(row.code) as RepairStageTemplate['code'],
    name: String(row.name),
    sortOrder: Number(row.sortOrder ?? 0),
    id: String(row.id),
    updatedAt: Number(row.updatedAt),
  };
  if (row.autoFrom) out.autoFrom = String(row.autoFrom) as NonNullable<RepairStageTemplate['autoFrom']>;
  if (row.sideBranch === true) out.sideBranch = true;
  out.archivedAt = row.archivedAt == null ? null : Number(row.archivedAt);
  return out;
}

export async function listRepairStageTemplates(
  opts: { includeArchived?: boolean } = {},
): Promise<Result<{ rows: RepairStageTemplate[] }>> {
  try {
    const rows = await db
      .select()
      .from(repairStageTemplates)
      .where(opts.includeArchived ? undefined : isNull(repairStageTemplates.archivedAt))
      // Боковая ветка — всегда после линейки, хоть у неё и приоритет 0.
      .orderBy(asc(repairStageTemplates.sideBranch), asc(repairStageTemplates.sortOrder), asc(repairStageTemplates.name));
    return { ok: true, rows: rows.map(rowToRepairStageTemplate) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export type UpsertRepairStageTemplateInput = {
  id?: string | undefined;
  code?: string | undefined;
  name: string;
  autoFrom?: string | null | undefined;
  sideBranch?: boolean | undefined;
  sortOrder?: number | undefined;
  actor?: string | null | undefined;
  expectedUpdatedAt?: number | undefined;
};

export async function upsertRepairStageTemplate(
  input: UpsertRepairStageTemplateInput,
): Promise<Result<{ row: RepairStageTemplate }>> {
  const name = text(input.name).slice(0, 120);
  if (!name) return { ok: false, error: 'Название этапа обязательно' };
  if (input.autoFrom != null && parseAutoFrom(input.autoFrom) === null && text(input.autoFrom)) {
    return { ok: false, error: 'Неизвестный источник автопростановки' };
  }
  const autoFrom = parseAutoFrom(input.autoFrom);
  const sideBranch = input.sideBranch === true;
  const now = Date.now();
  const actor = text(input.actor) || null;
  const id = text(input.id);

  try {
    if (id) {
      const [existing] = await db.select().from(repairStageTemplates).where(eq(repairStageTemplates.id, id)).limit(1);
      if (!existing) return { ok: false, error: 'Этап не найден' };
      if (
        typeof input.expectedUpdatedAt === 'number' &&
        Number.isFinite(input.expectedUpdatedAt) &&
        Number(existing.updatedAt) !== input.expectedUpdatedAt
      ) {
        return { ok: false, error: 'Этап успели изменить в другом месте — закройте окно и откройте его заново, иначе чужая правка пропадёт' };
      }
      const [row] = await db
        .update(repairStageTemplates)
        .set({
          name,
          autoFrom,
          sideBranch,
          ...(typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder) ? { sortOrder: Math.trunc(input.sortOrder) } : {}),
          updatedAt: now,
          updatedBy: actor,
        })
        .where(eq(repairStageTemplates.id, id))
        .returning();
      if (!row) return { ok: false, error: 'Этап не найден' };
      return { ok: true, row: rowToRepairStageTemplate(row) };
    }

    const code = text(input.code).toLowerCase();
    if (!WORK_SHEET_CODE_RE.test(code)) {
      return { ok: false, error: 'Код этапа — латиница, цифры и «_», от 2 до 40 знаков, с буквы' };
    }
    // Архивный этап код НЕ освобождает: на код ссылаются stage-строки.
    const [dup] = await db
      .select({ id: repairStageTemplates.id, archivedAt: repairStageTemplates.archivedAt })
      .from(repairStageTemplates)
      .where(eq(repairStageTemplates.code, code))
      .limit(1);
    if (dup) {
      return {
        ok: false,
        error: dup.archivedAt
          ? `Код «${code}» занят этапом в архиве — верните его из архива или назовите новый этап иначе`
          : `Этап с кодом «${code}» уже есть`,
      };
    }

    let sortOrder = typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder) : null;
    if (sortOrder == null) {
      const all = await db.select({ sortOrder: repairStageTemplates.sortOrder }).from(repairStageTemplates);
      const live = all.map((r) => Number(r.sortOrder ?? 0)).filter((n) => n > 0);
      sortOrder = (live.length > 0 ? Math.max(...live) : 0) + 10;
    }
    const [row] = await db
      .insert(repairStageTemplates)
      .values({ code, name, autoFrom, sideBranch, sortOrder, updatedAt: now, updatedBy: actor })
      .returning();
    if (!row) return { ok: false, error: 'Этап не создан' };
    return { ok: true, row: rowToRepairStageTemplate(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Архив, не удаление: stage-строки ссылаются на этап и обязаны читаться дальше. */
export async function archiveRepairStageTemplate(id: string, actor?: string | null): Promise<Result<{ id: string }>> {
  const key = text(id);
  if (!key) return { ok: false, error: 'id обязателен' };
  try {
    const [row] = await db
      .update(repairStageTemplates)
      .set({ archivedAt: Date.now(), updatedAt: Date.now(), updatedBy: text(actor) || null })
      .where(and(eq(repairStageTemplates.id, key), isNull(repairStageTemplates.archivedAt)))
      .returning({ id: repairStageTemplates.id });
    if (!row) return { ok: false, error: 'Этап не найден или уже в архиве' };
    return { ok: true, id: String(row.id) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Вернуть из архива (код должен быть свободен). */
export async function restoreRepairStageTemplate(id: string, actor?: string | null): Promise<Result<{ id: string }>> {
  const key = text(id);
  if (!key) return { ok: false, error: 'Этап не найден' };
  try {
    const [target] = await db.select().from(repairStageTemplates).where(eq(repairStageTemplates.id, key)).limit(1);
    if (!target) return { ok: false, error: 'Этап не найден' };
    const [dup] = await db
      .select({ id: repairStageTemplates.id })
      .from(repairStageTemplates)
      .where(and(eq(repairStageTemplates.code, target.code), isNull(repairStageTemplates.archivedAt), ne(repairStageTemplates.id, key)))
      .limit(1);
    if (dup) return { ok: false, error: `Код «${target.code}» уже занят другим этапом` };
    await db
      .update(repairStageTemplates)
      .set({ archivedAt: null, updatedAt: Date.now(), updatedBy: text(actor) || null })
      .where(eq(repairStageTemplates.id, key));
    return { ok: true, id: key };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Перестановка приоритетов целиком (drag-and-drop в справочнике): порядок массива —
 * новый порядок линейки, приоритеты пересчитываются 10, 20, … Боковая ветка в
 * перестановке не участвует — её приоритет всегда 0 и правится отдельно.
 */
export async function reorderRepairStageTemplates(
  ids: string[],
  actor?: string | null,
): Promise<Result<{ updated: number }>> {
  const keys = ids.map((v) => text(v)).filter(Boolean);
  if (keys.length === 0) return { ok: false, error: 'Пустой порядок' };
  try {
    const rows = await db.select().from(repairStageTemplates).where(isNull(repairStageTemplates.archivedAt));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const key of keys) {
      if (!byId.has(key)) return { ok: false, error: 'Этап не найден или в архиве' };
    }
    const now = Date.now();
    const by = text(actor) || null;
    let updated = 0;
    let order = 10;
    for (const key of keys) {
      const current = byId.get(key)!;
      if (current.sideBranch === true) continue;
      if (Number(current.sortOrder) !== order) {
        await db
          .update(repairStageTemplates)
          .set({ sortOrder: order, updatedAt: now, updatedBy: by })
          .where(eq(repairStageTemplates.id, key));
        updated++;
      }
      order += 10;
    }
    return { ok: true, updated };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Сколько живых stage-строк ссылается на код этапа. */
export async function countRepairStageRows(code: string): Promise<number> {
  const c = text(code);
  if (!c) return 0;
  try {
    const rows = await db
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.operationType, 'repair_history_entry'),
          isNull(operations.deletedAt),
          like(operations.metaJson, `%"stage":{"code":"${c}"%`),
        ),
      )
      .limit(20000);
    return rows.length;
  } catch {
    return 0;
  }
}

function operationPayload(row: {
  id: unknown;
  engineEntityId: unknown;
  operationType: unknown;
  status: unknown;
  note: unknown;
  performedAt: unknown;
  performedBy: unknown;
  metaJson: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  deletedAt: unknown;
  syncStatus: unknown;
}) {
  return {
    id: String(row.id),
    engine_entity_id: String(row.engineEntityId),
    operation_type: String(row.operationType),
    status: String(row.status),
    note: (row.note ?? null) as string | null,
    performed_at: (row.performedAt ?? null) as number | null,
    performed_by: (row.performedBy ?? null) as string | null,
    meta_json: (row.metaJson ?? null) as string | null,
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

/**
 * Слияние дублей этапов (PR-J): все живые stage-строки с кодом source переезжают
 * на target. Запись идёт через журнал (recordSyncChanges), парк получает
 * переезд инкрементальным pull. Исходный этап уходит в архив, код остаётся занят.
 * dryRun — только посчитать строки без записи.
 */
export async function mergeRepairStageTemplates(
  sourceId: string,
  targetId: string,
  actor: { id: string; username: string; role?: string },
  opts: { dryRun?: boolean } = {},
): Promise<Result<{ moved: number; sourceCode: string; targetCode: string; dryRun: boolean }>> {
  const sourceKey = text(sourceId);
  const targetKey = text(targetId);
  if (!sourceKey || !targetKey) return { ok: false, error: 'Укажите оба этапа' };
  if (sourceKey === targetKey) return { ok: false, error: 'Исходный и целевой этапы совпадают' };
  try {
    const [source] = await db.select().from(repairStageTemplates).where(eq(repairStageTemplates.id, sourceKey)).limit(1);
    const [target] = await db.select().from(repairStageTemplates).where(eq(repairStageTemplates.id, targetKey)).limit(1);
    if (!source || source.archivedAt != null) return { ok: false, error: 'Исходный этап не найден или в архиве' };
    if (!target || target.archivedAt != null) return { ok: false, error: 'Целевой этап не найден или в архиве' };
    if (Boolean(source.sideBranch) !== Boolean(target.sideBranch)) {
      return { ok: false, error: 'Линейный этап и боковую ветку объединять нельзя' };
    }
    const sourceCode = String(source.code);
    const targetCode = String(target.code);
    const sourceName = String(source.name);
    const targetName = String(target.name);

    const stageRows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.operationType, 'repair_history_entry'),
          isNull(operations.deletedAt),
          like(operations.metaJson, `%"stage":{"code":"${sourceCode}"%`),
        ),
      )
      .limit(20000);

    const moved: Array<Record<string, unknown>> = [];
    const now = Date.now();
    for (const row of stageRows as Array<Record<string, unknown>>) {
      let meta: any = null;
      try {
        meta = JSON.parse(String(row.metaJson ?? 'null'));
      } catch {
        continue;
      }
      if (!meta || typeof meta !== 'object' || String(meta?.stage?.code ?? '') !== sourceCode) continue;
      meta.stage = { ...(meta.stage ?? {}), code: targetCode, name: targetName };
      if (String(meta.action ?? '') === sourceName) meta.action = targetName;
      let note = row.note == null ? null : String(row.note);
      const prefix = `Этап: ${sourceName}`;
      if (note === prefix) note = `Этап: ${targetName}`;
      else if (note && note.startsWith(`${prefix} · `)) note = `Этап: ${targetName} · ${note.slice(prefix.length + 3)}`;
      moved.push(
        operationPayload({
          id: row.id,
          engineEntityId: row.engineEntityId,
          operationType: row.operationType,
          status: row.status,
          note,
          performedAt: row.performedAt,
          performedBy: row.performedBy,
          metaJson: JSON.stringify(meta),
          createdAt: row.createdAt,
          updatedAt: now,
          deletedAt: row.deletedAt,
          syncStatus: row.syncStatus,
        }),
      );
    }

    if (opts.dryRun === true) {
      return { ok: true, moved: moved.length, sourceCode, targetCode, dryRun: true };
    }
    if (moved.length > 0) {
      await recordSyncChanges(
        { id: actor.id, username: actor.username, ...(actor.role ? { role: actor.role } : {}) },
        moved.map((payload) => ({ tableName: SyncTableName.Operations, rowId: String(payload.id), op: 'upsert' as const, payload, ts: now })),
        { allowSyncConflicts: true },
      );
    }
    await db
      .update(repairStageTemplates)
      .set({ archivedAt: now, updatedAt: now, updatedBy: text(actor.username) || null })
      .where(and(eq(repairStageTemplates.id, sourceKey), isNull(repairStageTemplates.archivedAt)));
    return { ok: true, moved: moved.length, sourceCode, targetCode, dryRun: false };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Жёсткое удаление этапа, заведённого по ошибке. Со строками истории — отказ
 * (тогда только слияние или архив): код при удалении освобождается.
 */
export async function deleteRepairStageTemplate(
  id: string,
  actor?: string | null,
): Promise<Result<{ deletedCode: string }>> {
  const key = text(id);
  if (!key) return { ok: false, error: 'id обязателен' };
  try {
    const [target] = await db.select().from(repairStageTemplates).where(eq(repairStageTemplates.id, key)).limit(1);
    if (!target) return { ok: false, error: 'Этап не найден' };
    const refs = await countRepairStageRows(String(target.code));
    if (refs > 0) {
      return { ok: false, error: `У этапа ${refs} строк в истории — сначала объедините его или уберите в архив` };
    }
    const deleted = await db.delete(repairStageTemplates).where(eq(repairStageTemplates.id, key)).returning({ id: repairStageTemplates.id });
    if (deleted.length === 0) return { ok: false, error: 'Этап не найден' };
    void actor;
    return { ok: true, deletedCode: String(target.code) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

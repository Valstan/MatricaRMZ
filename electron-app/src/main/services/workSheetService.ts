import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  REPAIR_HISTORY_OPERATION_TYPE,
  STATUS_CODES,
  buildRepairHistoryMeta,
  buildWorkSheetFields,
  isEavFlagSet,
  isScrapEngine,
  missingRequiredWorkSheetFields,
  parseRepairHistoryMeta,
  repairHistoryEntryType,
  repairHistoryMetaForStatus,
  sanitizeWorkSheetColumns,
  workSheetFieldsSummary,
  type StatusCode,
  type WorkSheetField,
  type WorkSheetRow,
  type WorkSheetType,
} from '@matricarmz/shared';

import { advanceEngineStatusForWorkOrder, getEngineDetails, resolveEngineLabels } from './engineService.js';
import { addOperation, getOperation, listOperationsByType, softDeleteOperation, upsertOperation } from './operationService.js';

/**
 * Строки ведомостей работ (владелец 15.09.2026).
 *
 * Строка = запись истории ремонта двигателя (`operations` типа `repair_history_entry` с
 * `meta.sheet`): она сама попадает в карточку, ленту паспорта и ступени списка, дублей нет по
 * построению. Живёт в main-процессе намеренно — один актор, одна БД, и «записать строку» с
 * «поставить Отремонтирован» не гоняются между собой в рендерере.
 *
 * Узел с `completesRepair` (обкатка) при ДОБАВЛЕНИИ строки ставит `status_repaired` датой строки
 * тем же путём, что сборочный наряд (`advanceEngineStatusForWorkOrder`), и пишет автозапись
 * стадии — как делает карточка при взведённой галочке. Правка и удаление строки статус не
 * трогают: снятие «Отремонтирован» — решение оператора в карточке, не побочный эффект.
 */

export type SaveWorkSheetRowInput = {
  /** id операции; клиент генерирует при создании, правка приходит с тем же id. */
  id: string;
  engineId: string;
  /** Снимок узла на момент записи: строка несёт подписи полей с собой. */
  type: Pick<WorkSheetType, 'id' | 'code' | 'name' | 'completesRepair' | 'columns' | 'workshopId'>;
  /** Дата строки, мс. */
  atMs: number;
  workshopId?: string | null;
  workshopName?: string | null;
  note?: string | null;
  /** Значения по коду колонки — сырые, нормализуются здесь по типу колонки. */
  values: Record<string, unknown>;
};

export type SaveWorkSheetRowResult =
  | {
      ok: true;
      id: string;
      created: boolean;
      /** Что случилось со статусом «Отремонтирован» у узла, завершающего ремонт. */
      repair: { applied: boolean; reason?: string } | null;
    }
  | { ok: false; error: string };

function text(value: unknown): string {
  return String(value ?? '').trim();
}

export async function saveWorkSheetRow(db: BetterSQLite3Database, input: SaveWorkSheetRowInput, actor: string): Promise<SaveWorkSheetRowResult> {
  const id = text(input.id);
  const engineId = text(input.engineId);
  if (!id) return { ok: false, error: 'Нет id строки' };
  if (!engineId) return { ok: false, error: 'Укажите двигатель' };
  const typeCode = text(input.type?.code).toLowerCase();
  const typeName = text(input.type?.name) || typeCode;
  if (!typeCode) return { ok: false, error: 'Не указан узел ведомости' };
  const atMs = Number(input.atMs);
  if (!Number.isFinite(atMs) || atMs <= 0) return { ok: false, error: 'Укажите дату строки' };

  const columns = sanitizeWorkSheetColumns(input.type.columns ?? []);
  const fields: WorkSheetField[] = buildWorkSheetFields(columns, input.values ?? {});
  const missing = missingRequiredWorkSheetFields(columns, fields);
  if (missing.length > 0) return { ok: false, error: `Заполните: ${missing.join(', ')}` };

  const existing = await getOperation(db, id);
  if (existing) {
    const meta = parseRepairHistoryMeta(existing.metaJson ?? null);
    if (!meta || repairHistoryEntryType(meta, existing.operationType) !== 'sheet') {
      return { ok: false, error: 'Эта запись истории — не строка ведомости, править её здесь нельзя' };
    }
    if (text(existing.engineEntityId) !== engineId) {
      return { ok: false, error: 'Строку нельзя перевесить на другой двигатель — удалите и заведите заново' };
    }
  }

  const workshopId = text(input.workshopId) || text(input.type.workshopId) || null;
  // Имя цеха кладём снимком: справочник цехов живёт на сервере и требует `masterdata.view`,
  // а строка обязана читаться без него — иначе на экран уезжает uuid.
  const workshopName = text(input.workshopName) || null;
  const summary = workSheetFieldsSummary(fields);
  const meta = buildRepairHistoryMeta({
    action: typeName,
    at: atMs,
    workshopId,
    workshopName,
    ...(text(input.note) ? { note: text(input.note) } : {}),
    entryType: 'sheet',
    sheet: { typeId: text(input.type.id), typeCode, typeName, fields },
  });
  const noteLine = [`Ведомость: ${typeName}`, summary, text(input.note)].filter(Boolean).join(' · ');

  const { created } = await upsertOperation(db, {
    id,
    engineId,
    operationType: REPAIR_HISTORY_OPERATION_TYPE,
    status: 'done',
    note: noteLine,
    performedBy: actor,
    metaJson: JSON.stringify(meta),
  });

  let repair: { applied: boolean; reason?: string } | null = null;
  if (created && input.type.completesRepair === true) {
    repair = await completeRepairFromSheet(db, engineId, atMs, actor);
  }
  return { ok: true, id, created, repair };
}

/**
 * «Отремонтирован» датой строки. Утиль и уже отремонтированный — пропуск (дату не двигаем:
 * первая обкатка и есть дата ремонта). Автозапись стадии — той же формой, что пишет карточка.
 */
async function completeRepairFromSheet(db: BetterSQLite3Database, engineId: string, atMs: number, actor: string) {
  const details = await getEngineDetails(db, engineId);
  const attrs = details.attributes ?? {};
  const current: Partial<Record<StatusCode, boolean>> = {};
  for (const code of STATUS_CODES) current[code] = isEavFlagSet(attrs[code]);
  if (isScrapEngine(current)) return { applied: false, reason: 'scrap-engine' };
  if (current.status_repaired) return { applied: false, reason: 'already-repaired' };

  const result = await advanceEngineStatusForWorkOrder(db, engineId, 'status_repaired', atMs, actor);
  if (result.applied) {
    const statusMeta = repairHistoryMetaForStatus('status_repaired', atMs);
    await addOperation(db, engineId, REPAIR_HISTORY_OPERATION_TYPE, 'done', statusMeta.action, actor, JSON.stringify(statusMeta));
  }
  return result;
}

export async function deleteWorkSheetRow(db: BetterSQLite3Database, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await getOperation(db, text(id));
  if (!existing) return { ok: false, error: 'Строка не найдена' };
  const meta = parseRepairHistoryMeta(existing.metaJson ?? null);
  if (!meta || repairHistoryEntryType(meta, existing.operationType) !== 'sheet') {
    return { ok: false, error: 'Эта запись истории — не строка ведомости' };
  }
  await softDeleteOperation(db, text(id));
  return { ok: true };
}

/**
 * Строки всех ведомостей с подписями двигателей — новые сверху. Имя цеха отдаётся снимком из
 * самой строки: рендерер сначала спросит справочник (там свежее) и возьмёт снимок, только если
 * справочник недоступен — прав нет, офлайн, цех деактивирован.
 */
const WORK_SHEET_ROWS_LIMIT = 20_000;

export async function listWorkSheetRows(
  db: BetterSQLite3Database,
  opts: { sinceMs?: number | null; typeCode?: string | null } = {},
): Promise<{ rows: WorkSheetRow[]; truncated: boolean }> {
  const ops = await listOperationsByType(db, [REPAIR_HISTORY_OPERATION_TYPE], {
    sinceMs: opts.sinceMs ?? null,
    limit: WORK_SHEET_ROWS_LIMIT,
  });
  // Потолок выборки достигнут — значит показано не всё, и «Всего: N» без этой оговорки врёт.
  const truncated = ops.length >= WORK_SHEET_ROWS_LIMIT;
  const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0 ? opts.sinceMs : null;
  const picked: Array<{ op: (typeof ops)[number]; meta: NonNullable<ReturnType<typeof parseRepairHistoryMeta>> }> = [];
  for (const op of ops) {
    const meta = parseRepairHistoryMeta(op.metaJson ?? null);
    if (!meta?.sheet) continue;
    if (opts.typeCode && meta.sheet.typeCode !== text(opts.typeCode).toLowerCase()) continue;
    // Окно — по ДАТЕ СТРОКИ, а не по времени правки: строку заводят задним числом, и запись,
    // сделанную вчера о событии двухлетней давности, «за последний год» показывать нельзя.
    // SQL-окно по updated_at остаётся дешёвым предфильтром и ничего лишнего не отсекает:
    // строку заводят не раньше события, то есть at <= updated_at.
    if (sinceMs !== null && (meta.at ?? Number(op.performedAt ?? op.updatedAt)) < sinceMs) continue;
    picked.push({ op, meta });
  }
  const labels = await resolveEngineLabels(db, picked.map((p) => String(p.op.engineEntityId)));
  const rows: WorkSheetRow[] = picked.map(({ op, meta }) => {
    const label = labels.get(String(op.engineEntityId));
    return {
      id: String(op.id),
      engineId: String(op.engineEntityId),
      engineNumber: label?.engineNumber ?? '',
      engineBrand: label?.engineBrand ?? '',
      internalNumber: label?.internalNumberFull ?? '',
      at: meta.at ?? Number(op.performedAt ?? op.updatedAt),
      typeId: meta.sheet!.typeId,
      typeCode: meta.sheet!.typeCode,
      typeName: meta.sheet!.typeName,
      workshopId: meta.workshopId ?? '',
      workshopName: meta.workshopName ?? '',
      performedBy: text(op.performedBy) === 'local' ? '' : text(op.performedBy),
      note: meta.note ?? '',
      fields: meta.sheet!.fields,
    };
  });
  return { rows: rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)), truncated };
}

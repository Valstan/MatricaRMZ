import { randomUUID } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  HUMAN_LABEL_NO_NUMBER,
  REPAIR_HISTORY_ENTRY_TYPE_LABELS,
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
  statusDateCode,
  workSheetFieldsSummary,
  isSameWorkSheetDay,
  moscowDayKey,
  nextWorkSheetPass,
  repeatForPass,
  type GlobalSearchHit,
  type RepairStatusStamp,
  type StatusCode,
  type WorkSheetDuplicateRef,
  type WorkSheetField,
  type WorkSheetRow,
  type WorkSheetType,
} from '@matricarmz/shared';

import { operations } from '../database/schema.js';
import { advanceEngineStatusForWorkOrder, getEngineDetails, resolveEngineLabels, setEngineAttribute } from './engineService.js';
import { getOperation, listOperationsByType, softDeleteOperation, upsertOperation } from './operationService.js';

/**
 * Строки этапов работ (владелец 15.09.2026).
 *
 * Строка = запись истории ремонта двигателя (`operations` типа `repair_history_entry` с
 * `meta.sheet`): она сама попадает в карточку, ленту паспорта и ступени списка, дублей нет по
 * построению. Живёт в main-процессе намеренно — один актор, одна БД, и «записать строку» с
 * «поставить Отремонтирован» не гоняются между собой в рендерере.
 *
 * Узел с `completesRepair` (обкатка) при ДОБАВЛЕНИИ строки ставит `status_repaired` датой строки
 * тем же путём, что сборочный наряд (`advanceEngineStatusForWorkOrder`), и пишет автозапись
 * стадии — как делает карточка при взведённой галочке. Правка строки статус не трогает.
 *
 * Удаление строки предлагает откатить сделанное — по явному подтверждению оператора (решение
 * владельца 15.09.2026). Откат честен, потому что строка оставляет ШТАМП: какие флаги она
 * переключила, из чего в что, какой была дата и какую автозапись стадии она написала. Без
 * штампа это было бы угадывание — историю стадий пишут не все пути, а карточка не помнит, кто
 * поставил статус. Откатывается только то, что с тех пор никто не менял: если значение уже не
 * такое, каким его оставила строка, это чужое решение, и трогать его нельзя.
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
  /**
   * Осознанный повторный проход: оператор ответил на гейт дублей «двигатель вернулся на этот
   * этап». Без него строка, совпавшая с уже существующей по (двигатель, вид работ, день),
   * НЕ пишется — возвращается отказ с описанием найденных строк, и спрашивает оператора UI.
   * Пишущая сторона вопросов задавать не умеет, поэтому решение приходит сюда готовым.
   */
  repeatPass?: number | null;
  repeatReason?: string | null;
};

export type SaveWorkSheetRowResult =
  | {
      ok: true;
      id: string;
      created: boolean;
      /** Что случилось со статусом «Отремонтирован» у узла, завершающего ремонт. */
      repair: { applied: boolean; reason?: string } | null;
    }
  | {
      ok: false;
      error: string;
      /**
       * Отказ именно по дублю: строки, с которыми совпало, и номер прохода, который запись
       * получит, если оператор подтвердит возврат. UI по этому полю поднимает гейт, а не
       * показывает красную ошибку — совпадение не ошибка, это вопрос к человеку.
       */
      duplicate?: { refs: WorkSheetDuplicateRef[]; nextPass: number; typeName: string; atMs: number };
    };

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Строки того же этапа того же двигателя за тот же календарный день.
 *
 * Читает узкую выборку по индексу `operations_engine_type_idx (engine_entity_id, operation_type)`;
 * вид работ и дата лежат внутри `meta_json`, поэтому фильтр по ним — в JS, иначе понадобился бы
 * индекс по JSON, а он на клиенте и сервере разъедется (грабля **M142**).
 *
 * `excludeId` — сама сохраняемая строка: без него правка примечания считала бы строку дублем
 * самой себя. Мягко удалённые строки не учитываются: удалённый дубль дублем быть перестал.
 */
export async function listWorkSheetDuplicates(
  db: BetterSQLite3Database,
  args: { engineId: string; typeCode: string; atMs: number; excludeId?: string },
): Promise<WorkSheetDuplicateRef[]> {
  const engineId = text(args.engineId);
  const typeCode = text(args.typeCode).toLowerCase();
  if (!engineId || !typeCode || !Number.isFinite(args.atMs) || args.atMs <= 0) return [];
  const exclude = text(args.excludeId);

  const rows = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.engineEntityId, engineId),
        eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE),
        isNull(operations.deletedAt),
      ),
    )
    .orderBy(desc(operations.updatedAt))
    .limit(2000);

  const out: WorkSheetDuplicateRef[] = [];
  for (const row of rows as Array<Record<string, any>>) {
    const id = text(row.id);
    if (!id || id === exclude) continue;
    const meta = parseRepairHistoryMeta(row.metaJson ?? null);
    const sheet = meta?.sheet;
    if (!sheet) continue;
    if (text(sheet.typeCode).toLowerCase() !== typeCode) continue;
    // Дата этапа живёт только в meta.at: `performed_at` — момент записи строки, а не этапа.
    const at = typeof meta?.at === 'number' && Number.isFinite(meta.at) ? meta.at : null;
    if (at === null || !isSameWorkSheetDay(at, args.atMs)) continue;
    out.push({
      id,
      typeName: text(sheet.typeName) || text(sheet.typeCode),
      at,
      pass: meta?.repeat?.pass ?? 1,
      performedBy: text(row.performedBy) || null,
    });
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export async function saveWorkSheetRow(db: BetterSQLite3Database, input: SaveWorkSheetRowInput, actor: string): Promise<SaveWorkSheetRowResult> {
  const id = text(input.id);
  const engineId = text(input.engineId);
  if (!id) return { ok: false, error: 'Нет id строки' };
  if (!engineId) return { ok: false, error: 'Укажите двигатель' };
  const typeCode = text(input.type?.code).toLowerCase();
  const typeName = text(input.type?.name) || typeCode;
  if (!typeCode) return { ok: false, error: 'Не указан вид работ' };
  const atMs = Number(input.atMs);
  if (!Number.isFinite(atMs) || atMs <= 0) return { ok: false, error: 'Укажите дату строки' };

  const columns = sanitizeWorkSheetColumns(input.type.columns ?? []);
  const fields: WorkSheetField[] = buildWorkSheetFields(columns, input.values ?? {});
  const existing = await getOperation(db, id);
  const existingMeta = existing ? parseRepairHistoryMeta(existing.metaJson ?? null) : null;
  // Прежние поля — чтобы обязательность, наложенная на колонку задним числом, не заперла
  // уже записанную строку: править примечание в ней оператор должен мочь.
  const missing = missingRequiredWorkSheetFields(columns, fields, existingMeta?.sheet?.fields);
  if (missing.length > 0) return { ok: false, error: `Заполните: ${missing.join(', ')}` };

  if (existing) {
    const meta = existingMeta;
    if (!meta || repairHistoryEntryType(meta, existing.operationType) !== 'sheet') {
      return { ok: false, error: 'Эта запись истории — не строка этапа работ, править её здесь нельзя' };
    }
    if (text(existing.engineEntityId) !== engineId) {
      return { ok: false, error: 'Строку нельзя перевесить на другой двигатель — удалите и заведите заново' };
    }
  }

  // Гейт дублей — ПОСЛЕ проверок формы (незачем спрашивать про дубль у строки, которую всё
  // равно не примут) и ДО любой записи. Строка уже помеченная возвратом переспроса не требует:
  // решение по ней принято, и правка примечания не повод спрашивать заново.
  const explicitPass = Number(input.repeatPass);
  const confirmedRepeat = Number.isFinite(explicitPass) && explicitPass >= 2 ? Math.floor(explicitPass) : null;
  const carriedRepeat = existingMeta?.repeat ?? null;
  if (confirmedRepeat === null && !carriedRepeat) {
    const refs = await listWorkSheetDuplicates(db, { engineId, typeCode, atMs, excludeId: id });
    if (refs.length > 0) {
      const nextPass = nextWorkSheetPass(refs);
      return {
        ok: false,
        error: `На этот двигатель за ${moscowDayKey(atMs)} этап «${typeName}» уже внесён`,
        duplicate: { refs, nextPass, typeName, atMs },
      };
    }
  }
  const repeat = confirmedRepeat !== null ? repeatForPass(confirmedRepeat, text(input.repeatReason)) : carriedRepeat;

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
    // Штамп переживает правку: meta пересобирается целиком, и без переноса правка строки
    // молча стирала бы её след в карточке — удаление после правки уже нечего было бы
    // откатывать. Сам след правкой не меняется: статус при правке не трогается.
    ...(existingMeta?.repairStamp ? { repairStamp: existingMeta.repairStamp } : {}),
    // Признак возврата переживает правку по той же причине, что и штамп: meta пересобирается
    // целиком, и без переноса правка примечания молча разжаловала бы проход № 2 обратно в
    // первый — строка перестала бы отличаться от случайного дубля.
    ...(repeat ? { repeat } : {}),
  });
  const noteLine = [`Этап работ: ${typeName}`, summary, text(input.note)].filter(Boolean).join(' · ');

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
    const done = await completeRepairFromSheet(db, engineId, atMs, actor);
    repair = { applied: done.applied, ...(done.reason ? { reason: done.reason } : {}) };
    if (done.stamp) {
      // Штамп кладётся вторым проходом: что именно изменилось в карточке, известно только
      // после самого перехода. id тот же — это правка meta той же строки, не вторая строка.
      await upsertOperation(db, {
        id,
        engineId,
        operationType: REPAIR_HISTORY_OPERATION_TYPE,
        status: 'done',
        note: noteLine,
        performedBy: actor,
        metaJson: JSON.stringify({ ...meta, repairStamp: done.stamp }),
      });
    }
  }
  return { ok: true, id, created, repair };
}

/**
 * «Отремонтирован» датой строки. Утиль и уже отремонтированный — пропуск (дату не двигаем:
 * первая обкатка и есть дата ремонта). Автозапись стадии — той же формой, что пишет карточка.
 */
async function completeRepairFromSheet(
  db: BetterSQLite3Database,
  engineId: string,
  atMs: number,
  actor: string,
): Promise<{ applied: boolean; reason?: string; stamp?: RepairStatusStamp }> {
  const details = await getEngineDetails(db, engineId);
  const attrs = details.attributes ?? {};
  const current: Partial<Record<StatusCode, boolean>> = {};
  for (const code of STATUS_CODES) current[code] = isEavFlagSet(attrs[code]);
  if (isScrapEngine(current)) return { applied: false, reason: 'scrap-engine' };
  if (current.status_repaired) return { applied: false, reason: 'already-repaired' };

  const dateCode = statusDateCode('status_repaired');
  const dateBefore = typeof attrs[dateCode] === 'number' ? (attrs[dateCode] as number) : null;

  const result = await advanceEngineStatusForWorkOrder(db, engineId, 'status_repaired', atMs, actor);
  if (!result.applied) return result;

  const statusEntryId = randomUUID();
  const statusMeta = repairHistoryMetaForStatus('status_repaired', atMs);
  await upsertOperation(db, {
    id: statusEntryId,
    engineId,
    operationType: REPAIR_HISTORY_OPERATION_TYPE,
    status: 'done',
    note: statusMeta.action,
    performedBy: actor,
    metaJson: JSON.stringify(statusMeta),
  });

  // Что поменялось на самом деле — читаем из карточки ПОСЛЕ перехода, а не выводим из правил:
  // набор гасимых флагов задаёт `applyStatusFlagChange`, и копия этого правила здесь молча
  // разошлась бы с оригиналом.
  const after = await getEngineDetails(db, engineId);
  const attrsAfter = after.attributes ?? {};
  const flags: RepairStatusStamp['flags'] = [];
  for (const code of STATUS_CODES) {
    const from = current[code] === true;
    const to = isEavFlagSet(attrsAfter[code]);
    if (from !== to) flags.push({ code, from, to });
  }
  if (flags.length === 0) return { applied: true };
  return { applied: true, stamp: { statusEntryId, flags, dateCode, dateFrom: dateBefore, dateTo: atMs } };
}

/**
 * Вернуть карточке то, что оставила строка. Каждое значение возвращается, только если оно всё
 * ещё такое, каким его оставила строка: иначе после неё решение принял человек, и откат затёр
 * бы его. Пропущенное не ошибка — о нём сообщается вызывающему словами.
 */
async function rollbackRepairFromSheet(
  db: BetterSQLite3Database,
  engineId: string,
  stamp: RepairStatusStamp,
  actor: string,
): Promise<{ applied: boolean; reason?: string }> {
  const details = await getEngineDetails(db, engineId);
  const attrs = details.attributes ?? {};
  let changed = 0;
  let kept = 0;
  for (const flag of stamp.flags) {
    if (isEavFlagSet(attrs[flag.code]) !== flag.to) {
      kept += 1;
      continue;
    }
    await setEngineAttribute(db, engineId, flag.code, flag.from, actor);
    changed += 1;
  }
  if (changed === 0) return { applied: false, reason: 'changed-elsewhere' };
  const dateNow = typeof attrs[stamp.dateCode] === 'number' ? (attrs[stamp.dateCode] as number) : null;
  if (dateNow === stamp.dateTo) await setEngineAttribute(db, engineId, stamp.dateCode, stamp.dateFrom, actor);
  // Автозапись стадии гаснет вместе со статусом — иначе история продолжит утверждать, что
  // ремонт закончен, когда галочки в карточке уже нет.
  await softDeleteOperation(db, stamp.statusEntryId);
  return { applied: true, ...(kept > 0 ? { reason: 'partial' } : {}) };
}

/**
 * Один этап работ по id — для его карточки. Читается тем же путём, что и список (те же подписи
 * двигателя и снимок цеха), чтобы карточка и строка списка не расходились в мелочах.
 */
export async function getWorkSheetRow(db: BetterSQLite3Database, id: string): Promise<WorkSheetRow | null> {
  const existing = await getOperation(db, text(id));
  if (!existing || existing.deletedAt != null) return null;
  const meta = parseRepairHistoryMeta(existing.metaJson ?? null);
  if (!meta?.sheet || repairHistoryEntryType(meta, existing.operationType) !== 'sheet') return null;
  const labels = await resolveEngineLabels(db, [String(existing.engineEntityId)], { withCounterparty: true });
  const label = labels.get(String(existing.engineEntityId));
  return {
    id: String(existing.id),
    engineId: String(existing.engineEntityId),
    engineNumber: label?.engineNumber ?? '',
    engineBrand: label?.engineBrand ?? '',
    internalNumber: label?.internalNumberFull ?? '',
    customerName: label?.customerName ?? '',
    customerFullName: label?.customerFullName ?? '',
    contractNumber: label?.contractNumber ?? '',
    contractShortLabel: label?.contractShortLabel ?? '',
    at: meta.at ?? Number(existing.performedAt ?? existing.updatedAt),
    typeId: meta.sheet.typeId,
    typeCode: meta.sheet.typeCode,
    typeName: meta.sheet.typeName,
    workshopId: meta.workshopId ?? '',
    workshopName: meta.workshopName ?? '',
    performedBy: text(existing.performedBy) === 'local' ? '' : text(existing.performedBy),
    note: meta.note ?? '',
    fields: meta.sheet.fields,
    repairStamped: meta.repairStamp != null,
    repeatPass: meta.repeat?.pass ?? 1,
  };
}

export async function deleteWorkSheetRow(
  db: BetterSQLite3Database,
  id: string,
  opts: { rollbackRepair?: boolean } = {},
  actor = 'local',
): Promise<{ ok: true; repairRolledBack: boolean; reason?: string } | { ok: false; error: string }> {
  const existing = await getOperation(db, text(id));
  if (!existing) return { ok: false, error: 'Строка не найдена' };
  const meta = parseRepairHistoryMeta(existing.metaJson ?? null);
  if (!meta || repairHistoryEntryType(meta, existing.operationType) !== 'sheet') {
    return { ok: false, error: 'Эта запись истории — не строка этапа работ' };
  }
  let rolled: { applied: boolean; reason?: string } = { applied: false };
  if (opts.rollbackRepair === true && meta.repairStamp) {
    rolled = await rollbackRepairFromSheet(db, String(existing.engineEntityId), meta.repairStamp, actor);
  }
  await softDeleteOperation(db, text(id));
  return { ok: true, repairRolledBack: rolled.applied, ...(rolled.reason ? { reason: rolled.reason } : {}) };
}

/**
 * Строки всех этапов работ с подписями двигателей — новые сверху. Имя цеха отдаётся снимком из
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
  const labels = await resolveEngineLabels(db, picked.map((p) => String(p.op.engineEntityId)), { withCounterparty: true });
  const rows: WorkSheetRow[] = picked.map(({ op, meta }) => {
    const label = labels.get(String(op.engineEntityId));
    return {
      id: String(op.id),
      engineId: String(op.engineEntityId),
      engineNumber: label?.engineNumber ?? '',
      engineBrand: label?.engineBrand ?? '',
      internalNumber: label?.internalNumberFull ?? '',
      customerName: label?.customerName ?? '',
      customerFullName: label?.customerFullName ?? '',
      contractNumber: label?.contractNumber ?? '',
      contractShortLabel: label?.contractShortLabel ?? '',
      at: meta.at ?? Number(op.performedAt ?? op.updatedAt),
      typeId: meta.sheet!.typeId,
      typeCode: meta.sheet!.typeCode,
      typeName: meta.sheet!.typeName,
      workshopId: meta.workshopId ?? '',
      workshopName: meta.workshopName ?? '',
      performedBy: text(op.performedBy) === 'local' ? '' : text(op.performedBy),
      note: meta.note ?? '',
      fields: meta.sheet!.fields,
      repairStamped: meta.repairStamp != null,
      repeatPass: meta.repeat?.pass ?? 1,
    };
  });
  return { rows: rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)), truncated };
}

/**
 * Поиск строк этапов работ для Ctrl+K. Отдаёт готовые `GlobalSearchHit` — как единственный
 * другой main-поиск палитры (`searchEnginesByStampedPartNumber`), чтобы хит не переупаковывать.
 *
 * Не через `listWorkSheetRows`: тот берёт ВСЕ колонки до 20 000 строк (включая `meta_json`),
 * разбирает каждую и резолвит подписи двигателей по всей выборке вместе с договорами и
 * контрагентами. На каждую букву в палитре это тот же расход, что однажды уже стоил main
 * секунды на нажатие. Здесь — четыре узкие колонки, фильтр по типу в SQL (индекс
 * `operations_type_deleted_updated_idx` не поднимает блобы дефектовки), подстрочный префильтр
 * до `JSON.parse` и резолв подписей только по совпавшим строкам.
 *
 * Окна дат нет намеренно: у списка есть тумблер «за всё время», и поиск, слепой к тому, что
 * список находит, врал бы молча.
 */
const WORK_SHEET_SEARCH_MAX_OPS = 20_000;

/** Склейка без разделителей: «2401» находит «240-1», заодно складывает регистр. */
function compactText(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, '');
}

function formatSearchDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export async function searchWorkSheetRows(
  db: BetterSQLite3Database,
  args: { q: string; limit?: number },
): Promise<{ ok: true; hits: GlobalSearchHit[] } | { ok: false; error: string }> {
  try {
    const q = String(args.q ?? '').trim();
    if (!q) return { ok: true, hits: [] };
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const compactTokens = tokens.map(compactText).filter(Boolean);
    const limit = Math.min(Math.max(Number(args.limit ?? 12), 1), 50);

    const rows = await db
      .select({
        id: operations.id,
        engineEntityId: operations.engineEntityId,
        metaJson: operations.metaJson,
        performedAt: operations.performedAt,
        updatedAt: operations.updatedAt,
      })
      .from(operations)
      .where(and(eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE), isNull(operations.deletedAt)))
      .orderBy(desc(operations.updatedAt))
      .limit(WORK_SHEET_SEARCH_MAX_OPS);

    type Picked = { id: string; engineId: string; at: number; typeName: string };
    const picked: Picked[] = [];
    for (const r of rows) {
      const raw = r.metaJson ? String(r.metaJson) : '';
      if (!raw) continue;
      // Префильтр по сырой мете — каждый токен обязан в ней встретиться. Он дешёвый, но
      // грубый: в тексте лежат и uuid, и служебные ключи, поэтому ниже идёт точный матч
      // по человеческим полям — иначе запрос «sheet» находил бы всё подряд.
      const rawLower = raw.toLowerCase();
      const rawCompact = compactText(rawLower);
      let rough = true;
      for (let i = 0; i < tokens.length; i += 1) {
        const t = tokens[i]!;
        const c = compactTokens[i] ?? '';
        if (rawLower.includes(t) || (c && rawCompact.includes(c))) continue;
        rough = false;
        break;
      }
      if (!rough) continue;
      const meta = parseRepairHistoryMeta(raw);
      // В ведре `repair_history_entry` лежат ещё ручные записи, стадии и переезды — этап
      // работ узнаётся по `meta.sheet`, а не по префиксу примечания (у строк от 15.09 там
      // остался старый словарь, GOTCHAS M136).
      if (!meta?.sheet) continue;
      const hay = [meta.sheet.typeName, workSheetFieldsSummary(meta.sheet.fields), meta.note ?? '', meta.workshopName ?? '']
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const hayCompact = compactText(hay);
      let hit = true;
      for (let i = 0; i < tokens.length; i += 1) {
        const t = tokens[i]!;
        const c = compactTokens[i] ?? '';
        if (hay.includes(t) || (c && hayCompact.includes(c))) continue;
        hit = false;
        break;
      }
      if (!hit) continue;
      picked.push({
        id: String(r.id),
        engineId: String(r.engineEntityId ?? ''),
        at: meta.at ?? Number(r.performedAt ?? r.updatedAt),
        typeName: meta.sheet.typeName,
      });
      if (picked.length >= limit) break;
    }

    // Подписи двигателей — только по совпавшим строкам и без договоров с контрагентами:
    // в хите нужен один номер двигателя.
    const labels = await resolveEngineLabels(db, picked.map((p) => p.engineId), {});
    // Порядок сканирования (по времени правки) и порядок показа (по дате этапа) — разные:
    // строку правят позже, чем она датирована. Сортируем тем же компаратором, что список.
    const hits: GlobalSearchHit[] = picked
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
      .map((p) => {
        const engineNumber = labels.get(p.engineId)?.engineNumber?.trim() || HUMAN_LABEL_NO_NUMBER;
        const date = formatSearchDate(p.at);
        return {
          kind: 'work_sheet' as const,
          id: p.id,
          // Дословно заголовок вкладки из списка (WorkSheetsPage): открытая из палитры и
          // открытая из списка карточки обязаны называться одинаково.
          label: `${p.typeName || REPAIR_HISTORY_ENTRY_TYPE_LABELS.sheet} · ${engineNumber}`,
          ...(date ? { code: date } : {}),
        };
      });
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

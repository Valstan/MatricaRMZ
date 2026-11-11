import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { validateEngineReclamationQueue } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { erpEngineReclamations } from '../database/schema.js';
import { publishPendingEngineReclamations } from './sync/engineReclamationSyncPublisherService.js';

/**
 * Рекламации двигателя — серверная дверь.
 *
 * Очередь заездов по рекламации (владелец 10.11.2026): «рекламаций может быть
 * несколько, и они должны иметь свою очередность, то есть первая, вторая, третья,
 * чтобы у нас там даты прихода двигателя и отгрузки двигателя по рекламациям тоже
 * не пересекались друг с другом».
 *
 * Ведёт ТОЛЬКО эта дверь: строки пишутся обычным insert/update с
 * `sync_status = 'pending'`, а публикатор зеркала
 * (`engineReclamationSyncPublisherService`) доводит их до журнала — иначе
 * инкрементальный pull их не увидит никогда. Клиент читает реплику.
 */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type EngineReclamationRow = {
  id: string;
  engineId: string;
  queueNo: number;
  acceptedAt: number | null;
  shippedAt: number | null;
  customerReason: string | null;
  actualDefect: string | null;
  defectNature: string | null;
  actNumber: string | null;
  actDate: number | null;
  comment: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type EngineReclamationDraft = {
  id?: string | null | undefined;
  queueNo?: number | undefined;
  acceptedAt?: number | null | undefined;
  shippedAt?: number | null | undefined;
  customerReason?: string | null | undefined;
  actualDefect?: string | null | undefined;
  defectNature?: string | null | undefined;
  actNumber?: string | null | undefined;
  actDate?: number | null | undefined;
  comment?: string | null | undefined;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function mapRow(r: typeof erpEngineReclamations.$inferSelect): EngineReclamationRow {
  return {
    id: String(r.id),
    engineId: String(r.engineId),
    queueNo: Number(r.queueNo),
    acceptedAt: r.acceptedAt == null ? null : Number(r.acceptedAt),
    shippedAt: r.shippedAt == null ? null : Number(r.shippedAt),
    customerReason: r.customerReason == null ? null : String(r.customerReason),
    actualDefect: r.actualDefect == null ? null : String(r.actualDefect),
    defectNature: r.defectNature == null ? null : String(r.defectNature),
    actNumber: r.actNumber == null ? null : String(r.actNumber),
    actDate: r.actDate == null ? null : Number(r.actDate),
    comment: r.comment == null ? null : String(r.comment),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    deletedAt: r.deletedAt == null ? null : Number(r.deletedAt),
  };
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

function optionalMs(value: number | null | undefined, label: string): FieldResult<number | null> {
  if (value == null) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `${label} должна быть датой (мс)` };
  return { ok: true, value: n };
}

function optionalText(value: string | null | undefined, limit: number, label: string): FieldResult<string | null> {
  if (value == null) return { ok: true, value: null };
  const t = String(value);
  if (t.length > limit) return { ok: false, error: `${label} длиннее ${limit} символов` };
  const trimmed = t.trim();
  return { ok: true, value: trimmed ? trimmed : null };
}

/** Очередь рекламаций двигателя — по порядку заездов. */
export async function listEngineReclamations(engineId: string): Promise<Result<{ rows: EngineReclamationRow[] }>> {
  const id = String(engineId ?? '').trim();
  if (!isUuid(id)) return { ok: false, error: 'id двигателя должен быть uuid' };
  const rows = await db
    .select()
    .from(erpEngineReclamations)
    .where(and(eq(erpEngineReclamations.engineId, id as any), isNull(erpEngineReclamations.deletedAt)))
    .orderBy(asc(erpEngineReclamations.queueNo));
  return { ok: true, rows: rows.map(mapRow) };
}

/**
 * Полная замена очереди рекламаций двигателя.
 *
 * Как и строки плана ПП, очередь — один документ: клиент присылает её целиком.
 * Строки с известным id обновляются на месте, новые вставляются, пропавшие снимаются
 * мягко. Перед записью проверяется гейт дат (заезды не пересекаются).
 */
/**
 * Какая строка очереди правится под рекламацию из запроса.
 *
 * Клиент знает id строки только когда успела получить её из реплики; реплика
 * отстаёт от сервера, поэтому в запросе id часто нет (или он чужой). Без
 * разбора такой запрос ПЛЮДИЛ новую строку вместо правки прежней, а прежняя
 * смягко удалялась — у одного рекламационного номера оказывалось несколько строк,
 * и вторая запись падала на уникальном индексе (жалоба владельца 11.11.2026,
 * двигатель Е02АТ5382).
 *
 * Правило: своя строка — правим её; иначе ищем ту же рекламацию по НОМЕРУ в
 * очереди; и только если такой нет — заводим новую.
 */
export function resolveReclamationRowId(args: {
  /** Id из запроса (может быть пустым или чужим). */
  requestedId: string | null | undefined;
  /** Номер рекламации в очереди. */
  queueNo: number;
  /** Id строк ЭТОГО двигателя — живых и снятых. */
  ownIds: ReadonlySet<string>;
  /** Id, занятые другим двигателем: их брать нельзя. */
  foreignIds: ReadonlySet<string>;
  /** Живая строка по номеру рекламации. */
  liveIdByQueueNo: ReadonlyMap<number, string>;
  /** Новый id, когда править нечего. */
  newId: string;
}): string {
  const requested = String(args.requestedId ?? '').trim();
  if (requested && args.ownIds.has(requested) && !args.foreignIds.has(requested)) return requested;
  const same = args.liveIdByQueueNo.get(Number(args.queueNo));
  if (same) return same;
  return args.newId;
}

export async function replaceEngineReclamations(
  engineId: string,
  inputs: EngineReclamationDraft[],
  mainDates?: { mainArrivalDate?: number | null | undefined; mainShippingDate?: number | null | undefined },
): Promise<Result<{ count: number; rows: EngineReclamationRow[] }>> {
  const id = String(engineId ?? '').trim();
  if (!isUuid(id)) return { ok: false, error: 'id двигателя должен быть uuid' };

  const prepared: Array<{
    id: string | null;
    queueNo: number;
    acceptedAt: number | null;
    shippedAt: number | null;
    customerReason: string | null;
    actualDefect: string | null;
    defectNature: string | null;
    actNumber: string | null;
    actDate: number | null;
    comment: string | null;
  }> = [];

  for (let i = 0; i < inputs.length; i += 1) {
    const raw = inputs[i] ?? {};
    const queueNo = Number(raw.queueNo ?? i + 1);
    if (!Number.isFinite(queueNo) || queueNo <= 0) {
      return { ok: false, error: `рекламация ${i + 1}: номер в очереди должен быть положительным числом` };
    }
    const acceptedAt = optionalMs(raw.acceptedAt, `рекламация ${i + 1}: дата приёма`);
    if (!acceptedAt.ok) return acceptedAt;
    const shippedAt = optionalMs(raw.shippedAt, `рекламация ${i + 1}: дата отправки`);
    if (!shippedAt.ok) return shippedAt;
    const customerReason = optionalText(raw.customerReason, 4000, `рекламация ${i + 1}: описание дефекта`);
    if (!customerReason.ok) return customerReason;
    const actualDefect = optionalText(raw.actualDefect, 4000, `рекламация ${i + 1}: фактический дефект`);
    if (!actualDefect.ok) return actualDefect;
    const defectNature = optionalText(raw.defectNature, 500, `рекламация ${i + 1}: характер дефекта`);
    if (!defectNature.ok) return defectNature;
    const actNumber = optionalText(raw.actNumber, 200, `рекламация ${i + 1}: номер акта`);
    if (!actNumber.ok) return actNumber;
    const actDate = optionalMs(raw.actDate, `рекламация ${i + 1}: дата акта`);
    if (!actDate.ok) return actDate;
    const comment = optionalText(raw.comment, 4000, `рекламация ${i + 1}: комментарий`);
    if (!comment.ok) return comment;

    prepared.push({
      id: raw.id == null || String(raw.id).trim() === '' ? null : String(raw.id).trim(),
      queueNo,
      acceptedAt: acceptedAt.value,
      shippedAt: shippedAt.value,
      customerReason: customerReason.value,
      actualDefect: actualDefect.value,
      defectNature: defectNature.value,
      actNumber: actNumber.value,
      actDate: actDate.value,
      comment: comment.value,
    });
  }

  const gate = validateEngineReclamationQueue({
    rows: prepared,
    mainArrivalDate: mainDates?.mainArrivalDate ?? null,
    mainShippingDate: mainDates?.mainShippingDate ?? null,
  });
  if (gate) return { ok: false, error: gate };

  const existing = await db
    .select()
    .from(erpEngineReclamations)
    .where(eq(erpEngineReclamations.engineId, id as any));
  const existingById = new Map(existing.map((r) => [String(r.id), r]));
  const liveByQueueNo = new Map<number, string>();
  for (const row of existing) {
    if (row.deletedAt != null) continue;
    liveByQueueNo.set(Number(row.queueNo), String(row.id));
  }
  // Чужой id (занятый другим двигателем) не берём: строка не должна переезжать.
  const requestedIds = prepared.map((r) => r.id).filter((v): v is string => !!v && isUuid(v));
  const foreignIds = new Set<string>();
  if (requestedIds.length > 0) {
    const taken = await db
      .select({ id: erpEngineReclamations.id, engineId: erpEngineReclamations.engineId })
      .from(erpEngineReclamations)
      .where(inArray(erpEngineReclamations.id, requestedIds as any));
    for (const row of taken) {
      if (String(row.engineId) !== id) foreignIds.add(String(row.id));
    }
  }

  const now = Date.now();
  const keptIds = new Set<string>();
  const ownIds = new Set(existing.map((r) => String(r.id)));
  for (const row of prepared) {
    const rowId = resolveReclamationRowId({
      requestedId: row.id,
      queueNo: Number(row.queueNo),
      ownIds,
      foreignIds,
      liveIdByQueueNo: liveByQueueNo,
      newId: randomUUID(),
    });
    keptIds.add(rowId);
    const values = {
      engineId: id,
      queueNo: row.queueNo,
      acceptedAt: row.acceptedAt,
      shippedAt: row.shippedAt,
      customerReason: row.customerReason,
      actualDefect: row.actualDefect,
      defectNature: row.defectNature,
      actNumber: row.actNumber,
      actDate: row.actDate,
      comment: row.comment,
      updatedAt: now,
      syncStatus: 'pending',
    };
    const known = existingById.get(rowId);
    if (known) {
      // Возвращённая из архива строка оживает: снятый `deleted_at` — иначе она
      // осталась бы невидимой при живом `deleted_at is null` в выборках.
      await db
        .update(erpEngineReclamations)
        .set({ ...values, deletedAt: null })
        .where(eq(erpEngineReclamations.id, rowId as any));
    } else {
      await db.insert(erpEngineReclamations).values({ id: rowId as any, createdAt: now, ...values });
    }
  }

  // Пропавшие снимаем мягко — клиент увидит удаление через зеркало. Уже снятые
  // строки не трогаем: иначе они вечно переписывались бы и перепубликовывались.
  for (const row of existing) {
    const rowId = String(row.id);
    if (keptIds.has(rowId)) continue;
    if (row.deletedAt != null) continue;
    await db
      .update(erpEngineReclamations)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(eq(erpEngineReclamations.id, rowId as any));
  }

  // Публикация в журнал сразу, а не минутным тиком издателя: очередь — источник
  // правды, и отслеживание рекламации (синяя метка, отчёты, ведомости) читается из
  // её реплики. Без добора оператор видел бы пустые отчёты до минуты после сохранения.
  // Ошибка публикации не отменяет сохранение: тик издателя её повторит.
  try {
    await publishPendingEngineReclamations();
  } catch {
    /* публикатор доберёт строки следующим тиком */
  }

  // Итоговая очередь — с id строк. Клиент не должен перечитывать реплику сразу
  // после сохранения: она отстаёт от сервера (pull ещё не пришёл), и вкладка
  // показала бы пустую очередь — оператор жал «не сохраняется» и жал ещё раз,
  // плодя новые строки вместо правки прежней.
  const after = await listEngineReclamations(id);
  return { ok: true, count: prepared.length, rows: after.ok ? after.rows : [] };
}

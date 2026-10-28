/**
 * Сквозной номер карточки двигателя `RMZ451` — выдача и пометка удалений.
 *
 * Номер принадлежит СОЗДАНИЮ карточки, а не железу: повторный заезд двигателя —
 * новая карточка — новый номер. Поэтому здесь нет «события создания»: есть один
 * идемпотентный проход, который сверяет реестр `erp_engine_numbers` с тем, какие
 * карточки на сервере действительно есть.
 *
 * Почему сверка, а не хук: клиент создаёт карточку офлайн, и единственный источник
 * правды о том, «какая карточка существует», — сервер. Сверка спрашивает сервер,
 * а не ловит событие в момент, когда его может не быть.
 *
 * Одна ветка кода на три точки входа — бэкфилл, старт сервера и push-батч, — иначе
 * бэкфилл и обычная работа разошлись бы в поведении.
 *
 * Строки реестра не удаляются никогда: это и история, и гарантия, что номер не
 * выдадут второй раз. Удаление карточки живёт в `card_deleted_at` / `card_deleted_by`
 * и статусе (`deleted`), а не в базовом `deleted_at` контракта — базовое поле
 * означало бы удаление строки журнала, и история уехала бы из pull.
 */
import { SyncTableName } from '@matricarmz/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  auditLog,
  entities,
  entityTypes,
  erpEngineCards,
  erpEngineNumbers,
  ledgerTxIndex,
} from '../database/schema.js';
import { logError, logInfo } from '../utils/logger.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from './sync/syncWriteService.js';

/** Код типа карточки двигателя в EAV (`entity_types.code`). */
const ENGINE_ENTITY_TYPE = 'engine';
/** Столько карточек разбираем за один проход; бэкфилл вызывает проход в цикле. */
const BATCH_LIMIT = 2000;
/** Действие, которым клиент отмечает удаление карточки (причина — в payload). */
const DELETE_ACTION = 'engine.delete';

const SYSTEM_ACTOR: SyncWriteActor = { id: 'system', username: 'system', role: 'system' };

let running = false;

export type EngineNumberReconcileResult = {
  /** Сколько номеров выдано этим проходом. */
  issued: number;
  /** Сколько номеров помечено удалёнными (карточки больше нет). */
  markedDeleted: number;
  /** Сколько живых карточек осталось без номера — ненулевое только при `busy`. */
  pending: number;
  /** Проход уже идёт в этом процессе — работа передана ему. */
  busy: boolean;
};

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Кто завёл карточку — из журнала, не со слов клиента. Берём ПЕРВЫЙ upsert строки
 * `entities`: последующие правки актора не меняют.
 */
async function loadCreationActors(ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ rowId: ledgerTxIndex.rowId, actor: ledgerTxIndex.actorUsername })
    .from(ledgerTxIndex)
    .where(
      and(
        eq(ledgerTxIndex.tableName, SyncTableName.Entities),
        eq(ledgerTxIndex.op, 'upsert'),
        inArray(ledgerTxIndex.rowId, ids),
      ),
    )
    .orderBy(asc(ledgerTxIndex.serverSeq));
  for (const r of rows) {
    if (!out.has(r.rowId)) out.set(r.rowId, r.actor ?? null);
  }
  return out;
}

/** Почему удалили — из журнала действий (`engine.delete`, payload.reason). */
async function loadDeleteReasons(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ entityId: auditLog.entityId, payload: auditLog.payloadJson })
    .from(auditLog)
    .where(and(eq(auditLog.action, DELETE_ACTION), inArray(auditLog.entityId, ids)))
    .orderBy(desc(auditLog.createdAt));
  for (const r of rows) {
    if (!r.entityId || out.has(r.entityId)) continue;
    try {
      const parsed = JSON.parse(String(r.payload ?? '{}')) as { reason?: unknown };
      const reason = String(parsed.reason ?? '').trim();
      if (reason) out.set(r.entityId, reason);
    } catch {
      /* payload не JSON — причина останется пустой, это не повод ронять сверку */
    }
  }
  return out;
}

/** Кто удалил — из журнала (последняя delete-транзакция строки `entities`). */
async function loadDeleteActors(ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ rowId: ledgerTxIndex.rowId, actor: ledgerTxIndex.actorUsername })
    .from(ledgerTxIndex)
    .where(
      and(
        eq(ledgerTxIndex.tableName, SyncTableName.Entities),
        eq(ledgerTxIndex.op, 'delete'),
        inArray(ledgerTxIndex.rowId, ids),
      ),
    )
    .orderBy(desc(ledgerTxIndex.serverSeq));
  for (const r of rows) {
    if (!out.has(r.rowId)) out.set(r.rowId, r.actor ?? null);
  }
  return out;
}

/** «Что было в карточке» на момент удаления. */
async function loadSnapshots(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(erpEngineCards).where(inArray(erpEngineCards.id, ids));
  for (const row of rows) out.set(String(row.id), JSON.stringify(row));
  return out;
}

/**
 * Выдать номера живым карточкам без строки реестра. Порядок — по дате прихода
 * (самый ранний приезд получает `RMZ1`), **пустая дата — в начало**: у таких карточек
 * нет ни документа, ни даты, и номер карточки — единственное, чем их можно назвать
 * (решение владельца 28.10, уточняет порядок от 27.10). Дальше по времени создания и
 * id: порядок обязан быть воспроизводимым, иначе бэкфилл и обычная выдача дадут разные
 * номера одним и тем же карточкам.
 */
async function issueMissingNumbers(actor: SyncWriteActor): Promise<number> {
  const candidates = await db
    .select({
      id: entities.id,
      createdAt: entities.createdAt,
      arrivalDate: erpEngineCards.arrivalDate,
    })
    .from(entities)
    .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
    .leftJoin(erpEngineCards, eq(erpEngineCards.id, entities.id))
    .leftJoin(erpEngineNumbers, eq(erpEngineNumbers.id, entities.id))
    .where(
      and(
        eq(entityTypes.code, ENGINE_ENTITY_TYPE),
        isNull(entities.deletedAt),
        isNull(erpEngineNumbers.id),
      ),
    )
    .orderBy(sql`${erpEngineCards.arrivalDate} asc nulls first`, asc(entities.createdAt), asc(entities.id))
    .limit(BATCH_LIMIT);
  if (candidates.length === 0) return 0;

  // Номера выдаёт последовательность: nextval не транзакционен, поэтому откат
  // «сжигает» номер — так и просил владелец, номер уже использован.
  const seqResult = await db.execute(
    sql`select nextval('engine_rmz_seq') as seq from generate_series(1, ${candidates.length})`,
  );
  const seqs = ((seqResult as unknown as { rows?: Array<{ seq: unknown }> }).rows ?? []).map((r) =>
    asNumber(r.seq),
  );
  if (seqs.length !== candidates.length) {
    throw new Error(`engine_rmz_seq: выдано ${seqs.length} номеров на ${candidates.length} карточек`);
  }

  const creators = await loadCreationActors(candidates.map((c) => String(c.id)));
  const ts = Date.now();
  const inputs: SyncWriteInput[] = candidates.map((c, i) => ({
    type: 'upsert',
    table: SyncTableName.ErpEngineNumbers,
    row_id: String(c.id),
    row: {
      id: String(c.id),
      seq: seqs[i],
      status: 'active',
      created_by: creators.get(String(c.id)) ?? null,
      card_deleted_at: null,
      card_deleted_by: null,
      delete_reason: null,
      snapshot_json: null,
      created_at: asNumber(c.createdAt, ts),
      updated_at: ts,
      deleted_at: null,
    },
  }));
  await writeSyncChanges(inputs, actor, { allowSyncConflicts: true, skipEngineNumberReconcile: true });
  return inputs.length;
}

/**
 * Пометить удалёнными номера, чьей карточки больше нет. Номер остаётся за карточкой
 * навсегда: он не освобождается и не переиспользуется.
 */
async function markDeletedNumbers(actor: SyncWriteActor): Promise<number> {
  const stale = await db
    .select({
      id: erpEngineNumbers.id,
      seq: erpEngineNumbers.seq,
      createdAt: erpEngineNumbers.createdAt,
      createdBy: erpEngineNumbers.createdBy,
      deletedAt: entities.deletedAt,
    })
    .from(erpEngineNumbers)
    .leftJoin(entities, eq(entities.id, erpEngineNumbers.id))
    .where(
      and(
        eq(erpEngineNumbers.status, 'active'),
        or(isNull(entities.id), isNotNull(entities.deletedAt)),
      ),
    )
    .limit(BATCH_LIMIT);
  if (stale.length === 0) return 0;

  const ids = stale.map((s) => String(s.id));
  const [reasons, actors, snapshots] = await Promise.all([
    loadDeleteReasons(ids),
    loadDeleteActors(ids),
    loadSnapshots(ids),
  ]);
  const ts = Date.now();
  const inputs: SyncWriteInput[] = stale.map((s) => {
    const id = String(s.id);
    return {
      type: 'upsert',
      table: SyncTableName.ErpEngineNumbers,
      row_id: id,
      row: {
        id,
        seq: asNumber(s.seq),
        status: 'deleted',
        created_by: s.createdBy ?? null,
        // Время удаления карточки, а не время прохода: сверка может догнать его через часы.
        card_deleted_at: s.deletedAt == null ? ts : asNumber(s.deletedAt),
        card_deleted_by: actors.get(id) ?? null,
        delete_reason: reasons.get(id) ?? null,
        snapshot_json: snapshots.get(id) ?? null,
        created_at: asNumber(s.createdAt, ts),
        updated_at: ts,
        deleted_at: null,
      },
    };
  });
  await writeSyncChanges(inputs, actor, { allowSyncConflicts: true, skipEngineNumberReconcile: true });
  return inputs.length;
}

/**
 * Один идемпотентный проход. Возвращает счётчики; при уже идущем проходе в этом
 * процессе — `busy` без работы (повторный вызов не встаёт внахлёст).
 */
export async function reconcileEngineNumbers(
  opts: { actor?: SyncWriteActor } = {},
): Promise<EngineNumberReconcileResult> {
  if (running) return { issued: 0, markedDeleted: 0, pending: 0, busy: true };
  running = true;
  const actor = opts.actor ?? SYSTEM_ACTOR;
  try {
    const markedDeleted = await markDeletedNumbers(actor);
    const issued = await issueMissingNumbers(actor);
    if (issued > 0 || markedDeleted > 0) {
      logInfo('engine rmz numbers reconciled', { issued, markedDeleted });
    }
    return { issued, markedDeleted, pending: 0, busy: false };
  } finally {
    running = false;
  }
}

/**
 * Пинок после push-батча с двигателями. Ошибка не летит в ответ маршрута: канон уже
 * записан, номер догонит следующая сверка, а упавший push заставил бы клиента
 * повторять батч из-за чужой беды.
 */
export async function kickEngineNumberReconcile(): Promise<void> {
  try {
    await reconcileEngineNumbers();
  } catch (e) {
    logError('engine rmz numbers reconcile failed', { error: String(e) });
  }
}

/** Старт сервера: разово догнать то, что накопилось без сверки. Только primary. */
export function startEngineNumbersReconcile(): void {
  void kickEngineNumberReconcile();
}

/**
 * «Удалённое за 3 дня» — серверная сторона: список удалённых, восстановление, окончательное
 * удаление.
 *
 * ПОЧЕМУ СЕРВЕР, А НЕ КЛИЕНТ. Восстановление — это снятие метки удаления, то есть ИЗМЕНЕНИЕ
 * данных. Клиентский путь (снять метку у себя и залить push'ом) сервер отбивает:
 * `applyPushBatch` не принимает «undelete» без номера журнала, если у сервера уже есть
 * tombstone с известным seq. Значит, восстановление — серверная операция: сервер снимает
 * метку и пишет журнал изменений, и разойдётся по всем машинам.
 *
 * ЧТО ПОПАДАЕТ В СПИСОК. Мягко удалённые записи за последние `DELETED_RETENTION_DAYS` дней.
 * Отдельного хранилища «корзины удалённого» не заводим: удаление в программе мягкое —
 * запись помечена `deleted_at` и физически остаётся, истина одна.
 *
 * ЧЕСТНОСТЬ. Восстановление может быть неполным: пока объект был удалён, на него могли
 * ссылаться другие записи. Вернётся сам объект, связи могут остаться битыми — об этом
 * клиент предупреждает в подтверждении (см. `electron-app/.../pages/DeletedObjectsPage.tsx`).
 */
import { and, eq, gte, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { DELETED_RETENTION_DAYS, deletedObjectRestorePath, deletedObjectsSince } from '@matricarmz/shared';
import { SyncTableName } from '@matricarmz/shared';

import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  entities,
  entityTypes,
  erpContracts,
  erpCounterparties,
  erpEngineCards,
  fileAssets,
} from '../database/schema.js';
import { writeSyncChanges, type SyncWriteInput } from './sync/syncWriteService.js';
import { toContractInput, toCounterpartyInput, toEngineCardInput } from './sync/dictionarySyncPublisherService.js';

type Actor = { id: string; username: string; role?: string };

export type DeletedObjectRow = {
  /** Вид объекта ('engine' | 'contract' | …). */
  kind: string;
  id: string;
  /** Имя объекта — номер двигателя, номер договора, наименование. */
  name: string;
  /** Раздел, куда объект вернётся при восстановлении. */
  section: string;
  /** Когда удалён (мс). */
  deletedAt: number;
  /** Путь возврата: «Двигатели → Д-100». */
  restorePath: string;
  /**
   * Кем удалён — автор удаления из журнала действий. '' — автора в журнале нет
   * (удаление шло мимо журнала, или вид объекта журналом не пишет).
   */
  deletedBy: string;
};

/** Типы EAV-сущностей, которые попадают в список (код типа → вид объекта). */
const EAV_KIND_BY_TYPE_CODE: Record<string, string> = {
  supply_request: 'supply_request',
  work_order: 'work_order',
  masterdata: 'masterdata',
  employee: 'employee',
};

/** Виды объектов, которые лежат в EAV (`entities`), а не в строгих таблицах. */
const EAV_KINDS = new Set(Object.values(EAV_KIND_BY_TYPE_CODE));

function nowMs() {
  return Date.now();
}

function entityPayload(row: { id: string; typeId: string; createdAt: number; updatedAt: number; deletedAt: number | null; syncStatus: string }) {
  return {
    id: String(row.id),
    type_id: String(row.typeId),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function attributeValuePayload(row: {
  id: string;
  entityId: string;
  attributeDefId: string;
  valueJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    entity_id: String(row.entityId),
    attribute_def_id: String(row.attributeDefId),
    value_json: row.valueJson == null ? null : String(row.valueJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

/** Имя объекта из атрибутов EAV-сущности (первый непустой из известных). */
async function eavEntityNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ entityId: attributeValues.entityId, code: attributeDefs.code, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .where(inArray(attributeValues.entityId, ids as any));
  const codes = ['name', 'number', 'engine_number', 'full_name', 'request_number'];
  for (const row of rows) {
    const id = String(row.entityId);
    if (map.has(id)) continue;
    const code = String(row.code ?? '').trim().toLowerCase();
    if (!codes.includes(code)) continue;
    const value = String(row.valueJson ?? '').trim().replace(/^"|"$/g, '').trim();
    if (value) map.set(id, value);
  }
  return map;
}

/**
 * Кем удалён объект — автор последней строки удаления из журнала действий.
 *
 * ПОЧЕМУ ИЗ ЖУРНАЛА. Удаление мягкое: метку ставит оператор, а след удаления остаётся
 * в `audit_log` (`engine.delete`, `supply_request.delete`, …). Актора туда проставляет
 * сервер по сессии пуша (не клиент), поэтому автору можно верить. Своей колонки
 * «кто удалил» в мягко удалённых строках нет — и заводить её значило бы дублировать
 * журнал (глобальная линза: истина одна).
 */
async function resolveDeleteActors(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean)));
  if (unique.length === 0) return out;
  const rows = await db
    .select({ entityId: auditLog.entityId, action: auditLog.action, actor: auditLog.actor, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(inArray(auditLog.entityId, unique as any));
  const latest = new Map<string, { actor: string; at: number }>();
  for (const row of rows) {
    const id = String(row.entityId ?? '').trim();
    if (!id) continue;
    const action = String(row.action ?? '').trim().toLowerCase();
    if (!action.includes('delete')) continue;
    const at = Number(row.createdAt ?? 0);
    const prev = latest.get(id);
    if (!prev || at >= prev.at) latest.set(id, { actor: String(row.actor ?? '').trim(), at });
  }
  for (const [id, value] of latest) {
    if (value.actor) out.set(id, value.actor);
  }
  return out;
}

/**
 * След окончательного удаления в журнале действий: «удалил окончательно» — необратимо,
 * и журнал — место, где такая потеря обязана остаться видимой (промт КАРМАНА #169).
 * Пишем ДО удаления строки: после удаления имя объекта уже не откуда взять.
 */
async function writePurgeAudit(actor: Actor, kind: string, id: string, name: string): Promise<void> {
  const ts = nowMs();
  await db.insert(auditLog).values({
    id: randomUUID(),
    actor: actor.username,
    action: 'deleted.purge',
    entityId: id,
    tableName: kind,
    payloadJson: JSON.stringify({ objectName: name, kind, purgedAt: ts }),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
    lastServerSeq: null,
  });
}

/**
 * Имя объекта для следа в журнале. `null` — записи нет, и след писать не о чем.
 */
async function deletedObjectName(kind: string, id: string): Promise<string | null> {
  if (kind === 'engine') {
    const rows = await db.select({ name: erpEngineCards.engineNumber }).from(erpEngineCards).where(eq(erpEngineCards.id, id as any)).limit(1);
    return rows[0] ? String(rows[0].name ?? '').trim() : null;
  }
  if (kind === 'contract') {
    const rows = await db
      .select({ number: erpContracts.number, internalNumber: erpContracts.internalNumber, gozName: erpContracts.gozName })
      .from(erpContracts)
      .where(eq(erpContracts.id, id as any))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return String(row.number ?? row.internalNumber ?? row.gozName ?? '').trim();
  }
  if (kind === 'counterparty') {
    const rows = await db.select({ name: erpCounterparties.name }).from(erpCounterparties).where(eq(erpCounterparties.id, id as any)).limit(1);
    return rows[0] ? String(rows[0].name ?? '').trim() : null;
  }
  if (kind === 'file') {
    const rows = await db.select({ name: fileAssets.name }).from(fileAssets).where(eq(fileAssets.id, id as any)).limit(1);
    return rows[0] ? String(rows[0].name ?? '').trim() : null;
  }
  if (EAV_KINDS.has(kind)) {
    const rows = await db.select({ id: entities.id }).from(entities).where(eq(entities.id, id as any)).limit(1);
    if (!rows[0]) return null;
    const names = await eavEntityNames([String(rows[0].id)]);
    return names.get(String(rows[0].id)) ?? '';
  }
  return null;
}

/**
 * Список удалённого за окно (по умолчанию три дня).
 * `kind` — вид объекта; строки строгих таблиц и EAV-сущностей собираются отдельно.
 */
export async function listRecentlyDeleted(args?: { days?: number }): Promise<{ ok: true; rows: DeletedObjectRow[] }> {
  const days = Math.max(1, Math.floor(Number(args?.days ?? DELETED_RETENTION_DAYS)));
  const since = deletedObjectsSince(nowMs(), days);
  const rows: DeletedObjectRow[] = [];

  const engineRows = await db
    .select({ id: erpEngineCards.id, engineNumber: erpEngineCards.engineNumber, deletedAt: erpEngineCards.deletedAt })
    .from(erpEngineCards)
    .where(gte(erpEngineCards.deletedAt, since));
  for (const row of engineRows) {
    const name = String(row.engineNumber ?? '').trim();
    rows.push({ deletedBy: '', kind: 'engine', id: String(row.id), name, section: 'Двигатели', deletedAt: Number(row.deletedAt), restorePath: deletedObjectRestorePath('engine', name) });
  }

  const contractRows = await db
    .select({ id: erpContracts.id, number: erpContracts.number, internalNumber: erpContracts.internalNumber, gozName: erpContracts.gozName, deletedAt: erpContracts.deletedAt })
    .from(erpContracts)
    .where(gte(erpContracts.deletedAt, since));
  for (const row of contractRows) {
    const name = String(row.number ?? row.internalNumber ?? row.gozName ?? '').trim();
    rows.push({ deletedBy: '', kind: 'contract', id: String(row.id), name, section: 'Договоры', deletedAt: Number(row.deletedAt), restorePath: deletedObjectRestorePath('contract', name) });
  }

  const counterpartyRows = await db
    .select({ id: erpCounterparties.id, name: erpCounterparties.name, deletedAt: erpCounterparties.deletedAt })
    .from(erpCounterparties)
    .where(gte(erpCounterparties.deletedAt, since));
  for (const row of counterpartyRows) {
    const name = String(row.name ?? '').trim();
    rows.push({ deletedBy: '', kind: 'counterparty', id: String(row.id), name, section: 'Контрагенты', deletedAt: Number(row.deletedAt), restorePath: deletedObjectRestorePath('counterparty', name) });
  }

  const fileRows = await db
    .select({ id: fileAssets.id, name: fileAssets.name, deletedAt: fileAssets.deletedAt })
    .from(fileAssets)
    .where(gte(fileAssets.deletedAt, since));
  for (const row of fileRows) {
    const name = String(row.name ?? '').trim();
    rows.push({ deletedBy: '', kind: 'file', id: String(row.id), name, section: 'Файлы', deletedAt: Number(row.deletedAt), restorePath: deletedObjectRestorePath('file', name) });
  }

  // EAV-сущности (заявки, наряды, справочники, сотрудники).
  const typeRows = await db
    .select({ id: entityTypes.id, code: entityTypes.code })
    .from(entityTypes)
    .where(isNull(entityTypes.deletedAt));
  const typeCodeById = new Map<string, string>();
  for (const row of typeRows) typeCodeById.set(String(row.id), String(row.code ?? ''));
  const wantedTypeIds = Array.from(typeCodeById.entries()).filter(([, code]) => EAV_KIND_BY_TYPE_CODE[code]).map(([id]) => id);
  if (wantedTypeIds.length > 0) {
    const entityRows = await db
      .select({ id: entities.id, typeId: entities.typeId, deletedAt: entities.deletedAt })
      .from(entities)
      .where(and(inArray(entities.typeId, wantedTypeIds as any), gte(entities.deletedAt, since)));
    const names = await eavEntityNames(entityRows.map((row) => String(row.id)));
    for (const row of entityRows) {
      const code = typeCodeById.get(String(row.typeId)) ?? '';
      const kind = EAV_KIND_BY_TYPE_CODE[code] ?? 'masterdata';
      const name = names.get(String(row.id)) ?? '';
      const section = kind === 'employee' ? 'Сотрудники' : kind === 'supply_request' ? 'Заявки' : kind === 'work_order' ? 'Наряды' : 'Справочники';
      rows.push({ deletedBy: '', kind, id: String(row.id), name, section, deletedAt: Number(row.deletedAt), restorePath: deletedObjectRestorePath(kind, name) });
    }
  }

  // Кем удалён — из журнала действий (одна выборка на весь список).
  const actors = await resolveDeleteActors(rows.map((row) => row.id));
  for (const row of rows) row.deletedBy = actors.get(row.id) ?? '';

  rows.sort((a, b) => b.deletedAt - a.deletedAt);
  return { ok: true, rows };
}

/** Строгие таблицы: восстановление снимает метку и публикует строку в журнал изменений. */
async function restoreStrictRow(
  kind: string,
  id: string,
  actor: Actor,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const ts = nowMs();
  if (kind === 'engine') {
    const rows = await db.select().from(erpEngineCards).where(eq(erpEngineCards.id, id as any)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Запись не найдена' };
    await db.update(erpEngineCards).set({ deletedAt: null, updatedAt: ts, syncStatus: 'synced' }).where(eq(erpEngineCards.id, id as any));
    await writeSyncChanges([toEngineCardInput({ ...row, deletedAt: null, updatedAt: ts })], { id: actor.id, username: actor.username, role: actor.role ?? 'admin' });
    return { ok: true, name: String(row.engineNumber ?? '').trim() };
  }
  if (kind === 'contract') {
    const rows = await db.select().from(erpContracts).where(eq(erpContracts.id, id as any)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Запись не найдена' };
    await db.update(erpContracts).set({ deletedAt: null, updatedAt: ts, syncStatus: 'synced' }).where(eq(erpContracts.id, id as any));
    await writeSyncChanges([toContractInput({ ...row, deletedAt: null, updatedAt: ts })], { id: actor.id, username: actor.username, role: actor.role ?? 'admin' });
    return { ok: true, name: String(row.number ?? row.internalNumber ?? row.gozName ?? '').trim() };
  }
  if (kind === 'counterparty') {
    const rows = await db.select().from(erpCounterparties).where(eq(erpCounterparties.id, id as any)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Запись не найдена' };
    await db.update(erpCounterparties).set({ deletedAt: null, updatedAt: ts, syncStatus: 'synced' }).where(eq(erpCounterparties.id, id as any));
    await writeSyncChanges([toCounterpartyInput({ ...row, deletedAt: null, updatedAt: ts })], { id: actor.id, username: actor.username, role: actor.role ?? 'admin' });
    return { ok: true, name: String(row.name ?? '').trim() };
  }
  if (kind === 'file') {
    // Файлы живут на сервере (клиент их не реплицирует) — синхронизировать нечего.
    const rows = await db.select({ name: fileAssets.name }).from(fileAssets).where(eq(fileAssets.id, id as any)).limit(1);
    const name = String(rows[0]?.name ?? '').trim();
    const res = await db.update(fileAssets).set({ deletedAt: null }).where(eq(fileAssets.id, id as any));
    if (!res.rowCount) return { ok: false, error: 'Запись не найдена' };
    return { ok: true, name };
  }
  return { ok: false, error: `Вид объекта «${kind}» не восстанавливается` };
}

/**
 * Восстановить объект: снять метку удаления.
 * Возвращает путь возврата, чтобы клиент показал оператору, куда объект вернулся.
 */
export async function restoreDeletedObject(
  actor: Actor,
  args: { kind: string; id: string },
): Promise<{ ok: true; restorePath: string } | { ok: false; error: string }> {
  const kind = String(args.kind ?? '').trim();
  const id = String(args.id ?? '').trim();
  if (!kind || !id) return { ok: false, error: 'Нужны вид объекта и его id' };

  if (EAV_KINDS.has(kind)) {
    const rows = await db.select().from(entities).where(eq(entities.id, id as any)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Запись не найдена' };
    const ts = nowMs();
    await db.update(entities).set({ deletedAt: null, updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, id as any));
    const input: SyncWriteInput = {
      type: 'upsert',
      table: SyncTableName.Entities,
      row_id: String(row.id),
      row: entityPayload({ ...row, deletedAt: null, updatedAt: ts }),
    };
    await writeSyncChanges([input], { id: actor.id, username: actor.username, role: actor.role ?? 'admin' });
    const names = await eavEntityNames([String(row.id)]);
    const name = names.get(String(row.id)) ?? '';
    return { ok: true, restorePath: deletedObjectRestorePath(kind, name) };
  }

  const res = await restoreStrictRow(kind, id, actor);
  if (!res.ok) return res;
  // Путь возврата считаем по имени, которое вернуло восстановление: повторный запрос
  // списка после снятия метки ничего не нашёл бы — записи в списке удалённых уже нет.
  return { ok: true, restorePath: deletedObjectRestorePath(kind, res.name) };
}

/**
 * Удалить окончательно: запись исчезает из списка безвозвратно.
 * След в журнале действий остаётся (это не тихая потеря данных).
 */
export async function purgeDeletedObject(
  actor: Actor,
  args: { kind: string; id: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const kind = String(args.kind ?? '').trim();
  const id = String(args.id ?? '').trim();
  if (!kind || !id) return { ok: false, error: 'Нужны вид объекта и его id' };
  const ts = nowMs();

  // След в журнале действий: окончательное удаление необратимо, и журнал — место,
  // где такая потеря обязана остаться видимой (промт КАРМАНА #169). Пишем ДО удаления:
  // после удаления имя объекта уже не откуда взять.
  const purgeName = await deletedObjectName(kind, id);
  if (purgeName === null) return { ok: false, error: 'Запись не найдена' };
  await writePurgeAudit(actor, kind, id, purgeName);

  if (kind === 'engine' || kind === 'contract' || kind === 'counterparty') {
    // Сначала публикуем tombstone (клиенты должны убрать строку у себя), потом убираем её
    // у сервера: порядок наоборот оставил бы клиентов со строкой, которой на сервере нет.
    if (kind === 'engine') {
      const rows = await db.select().from(erpEngineCards).where(eq(erpEngineCards.id, id as any)).limit(1);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return { ok: false, error: 'Запись не найдена' };
      await writeSyncChanges([toEngineCardInput({ ...row, deletedAt: ts, updatedAt: ts })], { id: actor.id, username: actor.username, role: actor.role ?? 'admin' });
      await db.delete(erpEngineCards).where(eq(erpEngineCards.id, id as any));
      return { ok: true };
    }
    if (kind === 'contract') {
      const rows = await db.select().from(erpContracts).where(eq(erpContracts.id, id as any)).limit(1);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return { ok: false, error: 'Запись не найдена' };
      await writeSyncChanges([toContractInput({ ...row, deletedAt: ts, updatedAt: ts })], { id: actor.id, username: actor.username, role: actor.role ?? 'admin' });
      await db.delete(erpContracts).where(eq(erpContracts.id, id as any));
      return { ok: true };
    }
    const rows = await db.select().from(erpCounterparties).where(eq(erpCounterparties.id, id as any)).limit(1);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return { ok: false, error: 'Запись не найдена' };
    await writeSyncChanges([toCounterpartyInput({ ...row, deletedAt: ts, updatedAt: ts })], { id: actor.id, username: actor.username, role: actor.role ?? 'admin' });
    await db.delete(erpCounterparties).where(eq(erpCounterparties.id, id as any));
    return { ok: true };
  }

  if (kind === 'file') {
    const res = await db.delete(fileAssets).where(eq(fileAssets.id, id as any));
    if (!res.rowCount) return { ok: false, error: 'Запись не найдена' };
    return { ok: true };
  }

  // EAV-сущность: строка и её значения уходят совсем.
  const rows = await db.select().from(entities).where(eq(entities.id, id as any)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, error: 'Запись не найдена' };
  const valueRows = await db.select().from(attributeValues).where(eq(attributeValues.entityId, id as any));
  const inputs: SyncWriteInput[] = [
    {
      type: 'delete',
      table: SyncTableName.Entities,
      row_id: String(row.id),
      row: entityPayload({ ...row, deletedAt: ts, updatedAt: ts }),
    },
    ...valueRows.map(
      (value): SyncWriteInput => ({
        type: 'delete',
        table: SyncTableName.AttributeValues,
        row_id: String(value.id),
        row: attributeValuePayload({ ...value, deletedAt: ts, updatedAt: ts }),
      }),
    ),
  ];
  await writeSyncChanges(inputs, { id: actor.id, username: actor.username, role: actor.role ?? 'admin' });
  await db.delete(attributeValues).where(eq(attributeValues.entityId, id as any));
  await db.delete(entities).where(eq(entities.id, id as any));
  return { ok: true };
}

/**
 * «Посмотреть» — что это за объект и что в нём, БЕЗ восстановления.
 * Возвращает короткий набор полей (номер, марка, договор, …): полная карточка удалённого
 * объекта не нужна оператору, ему нужно узнать, тот ли это объект.
 */
export async function describeDeletedObject(
  args: { kind: string; id: string },
): Promise<{ ok: true; fields: Array<{ label: string; value: string }> } | { ok: false; error: string }> {
  const kind = String(args.kind ?? '').trim();
  const id = String(args.id ?? '').trim();
  if (!kind || !id) return { ok: false, error: 'Нужны вид объекта и его id' };
  const fields: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: unknown) => {
    const text = String(value ?? '').trim();
    if (text) fields.push({ label, value: text });
  };

  if (kind === 'engine') {
    const rows = await db.select().from(erpEngineCards).where(eq(erpEngineCards.id, id as any)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Запись не найдена' };
    push('Номер двигателя', row.engineNumber);
    push('Марка', row.engineBrand);
    push('Внутренний номер', row.engineInternalNumber);
    push('Дата прихода', row.arrivalDate ? new Date(Number(row.arrivalDate)).toISOString().slice(0, 10) : '');
    return { ok: true, fields };
  }
  if (kind === 'contract') {
    const rows = await db.select().from(erpContracts).where(eq(erpContracts.id, id as any)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Запись не найдена' };
    push('Номер договора', row.number);
    push('Внутренний номер', row.internalNumber);
    push('ГОЗ', row.gozName);
    return { ok: true, fields };
  }
  if (kind === 'counterparty') {
    const rows = await db.select().from(erpCounterparties).where(eq(erpCounterparties.id, id as any)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Запись не найдена' };
    push('Наименование', row.name);
    push('ИНН', row.inn);
    push('Телефон', row.phone);
    return { ok: true, fields };
  }
  if (kind === 'file') {
    const rows = await db.select().from(fileAssets).where(eq(fileAssets.id, id as any)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Запись не найдена' };
    push('Имя файла', row.name);
    push('Размер, байт', row.size);
    push('Тип', row.mime);
    return { ok: true, fields };
  }
  if (EAV_KINDS.has(kind)) {
    const rows = await db.select().from(entities).where(eq(entities.id, id as any)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Запись не найдена' };
    const typeRows = await db.select({ code: entityTypes.code }).from(entityTypes).where(eq(entityTypes.id, row.typeId as any)).limit(1);
    push('Тип объекта', typeRows[0]?.code);
    const names = await eavEntityNames([String(row.id)]);
    push('Наименование', names.get(String(row.id)));
    return { ok: true, fields };
  }
  return { ok: false, error: `Вид объекта «${kind}» не описан` };
}

/**
 * Уборка: записи старше окна удаляются окончательно (правило «храним три дня»).
 * Вызывается перед сборкой списка — тогда старые записи не просто исчезают из вида,
 * а уходят совсем.
 */
export async function purgeExpiredDeletedObjects(days: number = DELETED_RETENTION_DAYS): Promise<number> {
  const since = deletedObjectsSince(nowMs(), days);
  let purged = 0;

  const staleEngines = await db
    .select({ id: erpEngineCards.id })
    .from(erpEngineCards)
    .where(and(isNotNull(erpEngineCards.deletedAt), lt(erpEngineCards.deletedAt, since)));
  for (const row of staleEngines) {
    await db.delete(erpEngineCards).where(eq(erpEngineCards.id, row.id as any));
    purged += 1;
  }

  const staleContracts = await db
    .select({ id: erpContracts.id })
    .from(erpContracts)
    .where(and(isNotNull(erpContracts.deletedAt), lt(erpContracts.deletedAt, since)));
  for (const row of staleContracts) {
    await db.delete(erpContracts).where(eq(erpContracts.id, row.id as any));
    purged += 1;
  }

  const staleCounterparties = await db
    .select({ id: erpCounterparties.id })
    .from(erpCounterparties)
    .where(and(isNotNull(erpCounterparties.deletedAt), lt(erpCounterparties.deletedAt, since)));
  for (const row of staleCounterparties) {
    await db.delete(erpCounterparties).where(eq(erpCounterparties.id, row.id as any));
    purged += 1;
  }

  // Файлы — вид из реестра истории удалений, значит правило «три дня» относится и к ним:
  // старше срока строка уходит совсем (как и при ручном «удалить окончательно»).
  const staleFiles = await db
    .select({ id: fileAssets.id })
    .from(fileAssets)
    .where(and(isNotNull(fileAssets.deletedAt), lt(fileAssets.deletedAt, since)));
  for (const row of staleFiles) {
    await db.delete(fileAssets).where(eq(fileAssets.id, row.id as any));
    purged += 1;
  }

  // EAV-сущности: чистим только виды из реестра истории удалений (заявки, наряды,
  // справочники, сотрудники). Остальные типы EAV трогать нельзя: правило «три дня»
  // относится к истории удалений, а не ко всем мягко удалённым сущностям программы.
  const typeRows = await db
    .select({ id: entityTypes.id, code: entityTypes.code })
    .from(entityTypes)
    .where(isNull(entityTypes.deletedAt));
  const cleanupTypeIds = typeRows
    .filter((row) => EAV_KIND_BY_TYPE_CODE[String(row.code ?? '')])
    .map((row) => String(row.id));
  if (cleanupTypeIds.length > 0) {
    const staleEntities = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(inArray(entities.typeId, cleanupTypeIds as any), isNotNull(entities.deletedAt), lt(entities.deletedAt, since)));
    for (const row of staleEntities) {
      await db.delete(attributeValues).where(eq(attributeValues.entityId, row.id as any));
      await db.delete(entities).where(eq(entities.id, row.id as any));
      purged += 1;
    }
  }
  return purged;
}

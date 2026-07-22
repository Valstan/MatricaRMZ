/**
 * Клиентская половина advisory-резерва двигателя (Ф2 tablet-shop-floor).
 *
 * Резерв server-managed: клиент его читает из своей реплики (обычный pull
 * attribute_values), а меняет только этими вызовами. Ответ сервера сразу
 * применяется в локальную БД — плашка появляется, не дожидаясь синка.
 */
import {
  type EngineReservation,
  formatEngineReservationHolder,
  formatEngineReservationUntil,
  parseEngineReservation,
} from '@matricarmz/shared';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { attributeValues } from '../database/schema.js';
import { httpAuthed } from './httpClient.js';
import { SettingsKey, settingsGetString, settingsSetString } from './settingsStore.js';

const PENDING_RELEASE_CAP = 50;

export type EngineReservationInfo = { reservation: EngineReservation | null; serverNow: number };

export type EngineReservationResult =
  | ({ ok: true; queued?: boolean } & EngineReservationInfo)
  | { ok: false; error: string };

type ServerRow = {
  id?: string;
  entity_id?: string;
  attribute_def_id?: string;
  value_json?: string | null;
  created_at?: number;
  updated_at?: number;
  deleted_at?: number | null;
};

function formatHttpError(r: { status: number; json?: any; text?: string }): string {
  const body = r?.json && typeof r.json === 'object' ? r.json : null;
  const holder = body?.holder ? parseEngineReservation(body.holder) : null;
  if (holder) {
    return `Двигатель уже взял ${formatEngineReservationHolder(holder)} — ${formatEngineReservationUntil(holder.expiresAt)}`;
  }
  // Двигатель материализуется в БД только первой записью атрибута (deferred create),
  // поэтому на только что созданной карточке сервер честно отвечает 404.
  if (r.status === 404) return 'Сначала сохраните карточку двигателя, потом берите его в работу';
  const msg = typeof body?.error === 'string' ? body.error : typeof r.text === 'string' ? r.text.trim() : '';
  return `HTTP ${r.status}${msg ? `: ${msg}` : ''}`;
}

/**
 * Кладём строку резерва в реплику сразу, со `sync_status='synced'`: замок должен
 * быть виден мгновенно, а pending-строка ушла бы в push и была бы отбита
 * server-managed backstop'ом.
 */
async function applyReservationRow(dataDb: BetterSQLite3Database, row: ServerRow | null | undefined): Promise<void> {
  if (!row?.id || !row.entity_id || !row.attribute_def_id) return;
  const value = {
    valueJson: row.value_json == null ? null : String(row.value_json),
    updatedAt: Number(row.updated_at ?? Date.now()),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    syncStatus: 'synced',
  };
  // Апдейт по ПАРЕ (entity, attr), а не по id: у реплики мог остаться свой id той же
  // пары, и вставка споткнулась бы об attribute_values_entity_attr_uq.
  const updated = await dataDb
    .update(attributeValues)
    .set(value)
    .where(
      and(
        eq(attributeValues.entityId, String(row.entity_id)),
        eq(attributeValues.attributeDefId, String(row.attribute_def_id)),
      ),
    )
    .returning({ id: attributeValues.id });
  if (updated.length > 0) return;

  await dataDb
    .insert(attributeValues)
    .values({
      id: String(row.id),
      entityId: String(row.entity_id),
      attributeDefId: String(row.attribute_def_id),
      createdAt: Number(row.created_at ?? Date.now()),
      ...value,
    })
    .onConflictDoNothing();
}

function toInfo(json: any): EngineReservationInfo {
  return {
    reservation: parseEngineReservation(json?.reservation),
    serverNow: Number(json?.serverNow ?? Date.now()),
  };
}

async function readPendingReleases(sysDb: BetterSQLite3Database): Promise<string[]> {
  const raw = await settingsGetString(sysDb, SettingsKey.EngineReservationPendingRelease);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function writePendingReleases(sysDb: BetterSQLite3Database, ids: string[]): Promise<void> {
  await settingsSetString(
    sysDb,
    SettingsKey.EngineReservationPendingRelease,
    JSON.stringify([...new Set(ids)].slice(-PENDING_RELEASE_CAP)),
  );
}

export async function getEngineReservation(
  sysDb: BetterSQLite3Database,
  apiBaseUrl: string,
  engineId: string,
): Promise<EngineReservationResult> {
  const r = await httpAuthed(sysDb, apiBaseUrl, `/engines/${encodeURIComponent(engineId)}/reservation`, {
    method: 'GET',
  });
  if (!r.ok) return { ok: false, error: formatHttpError(r) };
  return { ok: true, ...toInfo(r.json) };
}

export async function acquireEngineReservation(
  sysDb: BetterSQLite3Database,
  dataDb: BetterSQLite3Database,
  apiBaseUrl: string,
  engineId: string,
): Promise<EngineReservationResult> {
  let r: Awaited<ReturnType<typeof httpAuthed>>;
  try {
    // attempts:1 — взятие не идемпотентно и оператор ждёт ответа у станка:
    // три ретрая с бэкоффом это ~90 с молчания вместо честного «нет связи».
    r = await httpAuthed(
      sysDb,
      apiBaseUrl,
      `/engines/${encodeURIComponent(engineId)}/reservation`,
      { method: 'POST' },
      { attempts: 1, timeoutMs: 15_000 },
    );
  } catch {
    return { ok: false, error: 'Нет связи с сервером — взять двигатель в работу можно только онлайн' };
  }
  if (!r.ok) return { ok: false, error: formatHttpError(r) };
  await applyReservationRow(dataDb, r.json?.row);
  return { ok: true, ...toInfo(r.json) };
}

export async function releaseEngineReservation(
  sysDb: BetterSQLite3Database,
  dataDb: BetterSQLite3Database,
  apiBaseUrl: string,
  engineId: string,
): Promise<EngineReservationResult> {
  let r: Awaited<ReturnType<typeof httpAuthed>>;
  try {
    r = await httpAuthed(sysDb, apiBaseUrl, `/engines/${encodeURIComponent(engineId)}/reservation`, {
      method: 'DELETE',
    });
  } catch {
    await writePendingReleases(sysDb, [...(await readPendingReleases(sysDb)), engineId]);
    return { ok: true, queued: true, reservation: null, serverNow: Date.now() };
  }
  // 5xx/сеть — тот же случай «нет связи»: намерение не теряем, вернём при синке.
  if (!r.ok && r.status >= 500) {
    await writePendingReleases(sysDb, [...(await readPendingReleases(sysDb)), engineId]);
    return { ok: true, queued: true, reservation: null, serverNow: Date.now() };
  }
  if (!r.ok) return { ok: false, error: formatHttpError(r) };
  await applyReservationRow(dataDb, r.json?.row);
  return { ok: true, ...toInfo(r.json) };
}

/** Досылка отложенных снятий: дёргается после успешного синка. */
export async function flushPendingEngineReservationReleases(
  sysDb: BetterSQLite3Database,
  dataDb: BetterSQLite3Database,
  apiBaseUrl: string,
): Promise<number> {
  const queued = await readPendingReleases(sysDb);
  if (queued.length === 0) return 0;

  const left: string[] = [];
  let sent = 0;
  for (const engineId of queued) {
    try {
      const r = await httpAuthed(sysDb, apiBaseUrl, `/engines/${encodeURIComponent(engineId)}/reservation`, {
        method: 'DELETE',
      });
      // 403 — резерв успел перейти другому: намерение устарело, из очереди убираем.
      if (r.ok || r.status === 403 || r.status === 404) {
        if (r.ok) await applyReservationRow(dataDb, r.json?.row);
        sent += 1;
        continue;
      }
      left.push(engineId);
    } catch {
      left.push(engineId);
    }
  }
  await writePendingReleases(sysDb, left);
  return sent;
}

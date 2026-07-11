import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_UI_CONTROL_SETTINGS,
  DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA,
  UI_DEFAULTS_VERSION,
  sanitizeUiControlSettings,
  sanitizeWarehouseBomRelationSchema,
} from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { clientSettings, statisticsActiveTime } from '../database/schema.js';
import { ingestServerCriticalEvent } from './criticalEventsService.js';
import { logWarn } from '../utils/logger.js';

export type ClientSettingsRow = typeof clientSettings.$inferSelect;

type ClientSettingsPatch = Partial<
  Pick<
    ClientSettingsRow,
    'updatesEnabled' | 'torrentEnabled' | 'loggingEnabled' | 'loggingMode' | 'uiGlobalSettingsJson' | 'bomRelationSchemaJson' | 'uiDefaultsVersion'
  >
>;
type ClientSyncRequest = { id: string; type: string; at: number; payload?: string | null };
type ClientSyncAck = { requestId: string; status: 'ok' | 'error'; error?: string | null; at?: number };

let clientSettingsSchemaReadyPromise: Promise<void> | null = null;
let clientSettingsSchemaReadyLogged = false;

async function ensureClientSettingsSchemaReady() {
  if (!clientSettingsSchemaReadyPromise) {
    clientSettingsSchemaReadyPromise = (async () => {
      // Compatibility self-heal: protects API from 500 on nodes where some
      // historical client_settings migrations were skipped.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "client_settings" (
          "client_id" text PRIMARY KEY NOT NULL,
          "updates_enabled" boolean DEFAULT true NOT NULL,
          "torrent_enabled" boolean DEFAULT true NOT NULL,
          "logging_enabled" boolean DEFAULT false NOT NULL,
          "logging_mode" text DEFAULT 'prod' NOT NULL,
          "last_seen_at" bigint,
          "last_version" text,
          "created_at" bigint NOT NULL,
          "updated_at" bigint NOT NULL
        );
      `);
      await pool.query(`
        ALTER TABLE "client_settings"
          ADD COLUMN IF NOT EXISTS "last_ip" text,
          ADD COLUMN IF NOT EXISTS "last_hostname" text,
          ADD COLUMN IF NOT EXISTS "last_platform" text,
          ADD COLUMN IF NOT EXISTS "last_arch" text,
          ADD COLUMN IF NOT EXISTS "sync_request_id" text,
          ADD COLUMN IF NOT EXISTS "sync_request_type" text,
          ADD COLUMN IF NOT EXISTS "sync_request_at" bigint,
          ADD COLUMN IF NOT EXISTS "sync_request_payload" text,
          ADD COLUMN IF NOT EXISTS "last_username" text,
          ADD COLUMN IF NOT EXISTS "ui_global_settings_json" text,
          ADD COLUMN IF NOT EXISTS "bom_relation_schema_json" text,
          ADD COLUMN IF NOT EXISTS "ui_defaults_version" integer NOT NULL DEFAULT 1;
      `);
      if (!clientSettingsSchemaReadyLogged) {
        clientSettingsSchemaReadyLogged = true;
        logWarn('client_settings schema compatibility check completed');
      }
    })().catch((e) => {
      clientSettingsSchemaReadyPromise = null;
      throw e;
    });
  }
  await clientSettingsSchemaReadyPromise;
}

function nowMs() {
  return Date.now();
}

function safeJsonParse(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function defaultSettings(): Omit<ClientSettingsRow, 'clientId' | 'createdAt' | 'updatedAt'> {
  return {
    updatesEnabled: true,
    torrentEnabled: true,
    loggingEnabled: true,
    loggingMode: 'dev',
    uiGlobalSettingsJson: JSON.stringify(DEFAULT_UI_CONTROL_SETTINGS),
    bomRelationSchemaJson: JSON.stringify(DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA),
    uiDefaultsVersion: UI_DEFAULTS_VERSION,
    syncRequestId: null,
    syncRequestType: null,
    syncRequestAt: null,
    syncRequestPayload: null,
    lastSeenAt: null,
    lastVersion: null,
    lastIp: null,
    lastHostname: null,
    lastPlatform: null,
    lastArch: null,
    lastUsername: null,
  };
}

const GLOBAL_CLIENT_SETTINGS_ID = '__global_ui_defaults__';

export async function getOrCreateClientSettings(clientId: string): Promise<ClientSettingsRow> {
  await ensureClientSettingsSchemaReady();
  const rows = await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1);
  if (rows[0]) return rows[0];
  const ts = nowMs();
  const defaults = defaultSettings();
  const row: ClientSettingsRow = {
    clientId,
    updatesEnabled: defaults.updatesEnabled,
    torrentEnabled: defaults.torrentEnabled,
    loggingEnabled: defaults.loggingEnabled,
    loggingMode: defaults.loggingMode,
    uiGlobalSettingsJson: defaults.uiGlobalSettingsJson,
    bomRelationSchemaJson: defaults.bomRelationSchemaJson,
    uiDefaultsVersion: defaults.uiDefaultsVersion,
    syncRequestId: defaults.syncRequestId,
    syncRequestType: defaults.syncRequestType,
    syncRequestAt: defaults.syncRequestAt,
    syncRequestPayload: defaults.syncRequestPayload,
    lastSeenAt: null,
    lastVersion: null,
    lastIp: null,
    lastHostname: null,
    lastPlatform: null,
    lastArch: null,
    lastUsername: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(clientSettings).values(row);
  return row;
}

export async function touchClientSettings(
  clientId: string,
  args: {
    version?: string | null;
    ip?: string | null;
    hostname?: string | null;
    platform?: string | null;
    arch?: string | null;
    username?: string | null;
  },
): Promise<void> {
  const ts = nowMs();
  await db
    .update(clientSettings)
    .set({
      lastSeenAt: ts,
      lastVersion: args.version ?? null,
      lastIp: args.ip ?? null,
      lastHostname: args.hostname ?? null,
      lastPlatform: args.platform ?? null,
      lastArch: args.arch ?? null,
      // undefined = keep the stored value (e.g. an old client sent a username the
      // server can't verify yet); null = clear (client is logged out).
      ...(args.username !== undefined ? { lastUsername: args.username } : {}),
      updatedAt: ts,
    })
    .where(eq(clientSettings.clientId, clientId));
  if (args.username) await warnOnMultiMachineLogin(clientId, String(args.username), ts);
}

/**
 * Один логин, активный на нескольких машинах одновременно, ломает атрибуцию
 * (performed_by/row_owners пишутся логином сессии), выключает разделные гейты при
 * superadmin и шарит per-user черновики между машинами (инцидент 2026-07-10: valstan
 * на PC34/PC40/PC41 → «самопроизвольные» правки). Поднимаем warn-критсобытие; dedup
 * по составу машин, чтобы каждый heartbeat не плодил повторы.
 */
const MULTI_LOGIN_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

async function warnOnMultiMachineLogin(clientId: string, username: string, ts: number): Promise<void> {
  try {
    const login = username.trim().toLowerCase();
    if (!login) return;
    const rows = await db
      .select({ clientId: clientSettings.clientId, lastHostname: clientSettings.lastHostname, lastSeenAt: clientSettings.lastSeenAt })
      .from(clientSettings)
      .where(sql`lower(${clientSettings.lastUsername}) = ${login} AND ${clientSettings.lastSeenAt} > ${ts - MULTI_LOGIN_ACTIVE_WINDOW_MS}`);
    if (rows.length < 2) return;
    const machines = rows
      .map((r) => String(r.lastHostname ?? '').trim() || String(r.clientId).slice(0, 8))
      .sort((a, b) => a.localeCompare(b, 'ru'));
    ingestServerCriticalEvent({
      eventCode: 'auth.multi_machine_login',
      title: `Логин «${login}» активен на ${rows.length} машинах`,
      humanMessage:
        `Пользователь «${login}» одновременно работает на машинах: ${machines.join(', ')}. ` +
        'Наряды и правки с этих машин записываются на этот логин (атрибуция искажается), ' +
        'а черновики карточек становятся общими. Каждому оператору — свой логин.',
      category: 'auth',
      severity: 'warn',
      clientId,
      dedupMessage: `auth.multi_machine_login:${login}:${machines.join(',')}`,
    });
  } catch {
    // heartbeat никогда не должен падать из-за диагностики
  }
}

// «Активное» время: клиент шлёт кумулятив за свой локальный день (activeMs) на heartbeat'е.
// Кумулятив монотонный → берём GREATEST (идемпотентно, retry-safe, без двойного учёта).
export async function recordClientActiveTime(args: {
  clientId: string;
  login: string;
  activeDate: string;
  activeMs: number;
}): Promise<void> {
  const clientId = String(args.clientId ?? '').trim();
  const login = String(args.login ?? '').trim().toLowerCase();
  const activeDate = String(args.activeDate ?? '').trim();
  const activeMs = Math.trunc(Number(args.activeMs ?? 0));
  if (!clientId || !login || !/^\d{4}-\d{2}-\d{2}$/.test(activeDate) || !Number.isFinite(activeMs) || activeMs <= 0) return;
  const ts = nowMs();
  await db
    .insert(statisticsActiveTime)
    .values({ summaryDate: activeDate, clientId, login, activeMs, updatedAt: ts })
    .onConflictDoUpdate({
      target: [statisticsActiveTime.summaryDate, statisticsActiveTime.clientId],
      set: {
        activeMs: sql`GREATEST(${statisticsActiveTime.activeMs}, ${activeMs})`,
        login,
        updatedAt: ts,
      },
    });
}

export async function listClientSettings(): Promise<ClientSettingsRow[]> {
  await ensureClientSettingsSchemaReady();
  return await db.select().from(clientSettings);
}

export async function updateClientSettings(clientId: string, patch: ClientSettingsPatch): Promise<ClientSettingsRow> {
  await getOrCreateClientSettings(clientId);
  const ts = nowMs();
  await db
    .update(clientSettings)
    .set({
      ...(patch.updatesEnabled !== undefined ? { updatesEnabled: patch.updatesEnabled } : {}),
      ...(patch.torrentEnabled !== undefined ? { torrentEnabled: patch.torrentEnabled } : {}),
      ...(patch.loggingEnabled !== undefined ? { loggingEnabled: patch.loggingEnabled } : {}),
      ...(patch.loggingMode !== undefined ? { loggingMode: patch.loggingMode } : {}),
      ...(patch.uiGlobalSettingsJson !== undefined ? { uiGlobalSettingsJson: patch.uiGlobalSettingsJson } : {}),
      ...(patch.bomRelationSchemaJson !== undefined ? { bomRelationSchemaJson: patch.bomRelationSchemaJson } : {}),
      ...(patch.uiDefaultsVersion !== undefined ? { uiDefaultsVersion: patch.uiDefaultsVersion } : {}),
      updatedAt: ts,
    })
    .where(eq(clientSettings.clientId, clientId));
  const rows = await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1);
  return rows[0] ?? (await getOrCreateClientSettings(clientId));
}

export async function setClientSyncRequest(clientId: string, req: ClientSyncRequest): Promise<ClientSettingsRow> {
  await getOrCreateClientSettings(clientId);
  const ts = nowMs();
  await db
    .update(clientSettings)
    .set({
      syncRequestId: req.id,
      syncRequestType: req.type,
      syncRequestAt: req.at,
      syncRequestPayload: req.payload ?? null,
      updatedAt: ts,
    })
    .where(eq(clientSettings.clientId, clientId));
  const rows = await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1);
  return rows[0] ?? (await getOrCreateClientSettings(clientId));
}

export async function acknowledgeClientSyncRequest(clientId: string, ack: ClientSyncAck): Promise<ClientSettingsRow> {
  await getOrCreateClientSettings(clientId);
  const row = (await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1))[0] ?? null;
  if (!row) return await getOrCreateClientSettings(clientId);
  if (!row.syncRequestId || String(row.syncRequestId) !== String(ack.requestId)) return row;
  const ts = nowMs();
  const previousPayload = safeJsonParse(row.syncRequestPayload ?? null);
  const autohealPayload = previousPayload?.autoheal && typeof previousPayload.autoheal === 'object' ? previousPayload.autoheal : null;
  const payload = {
    ...(autohealPayload ? { autoheal: autohealPayload } : {}),
    ackAt: Number(ack.at ?? ts),
    ackStatus: ack.status,
    ...(ack.error ? { ackError: String(ack.error) } : {}),
    requestId: row.syncRequestId,
  };
  await db
    .update(clientSettings)
    .set({
      syncRequestId: null,
      syncRequestType: null,
      syncRequestAt: null,
      syncRequestPayload: JSON.stringify(payload),
      updatedAt: ts,
    })
    .where(eq(clientSettings.clientId, clientId));
  const next = await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1);
  return next[0] ?? (await getOrCreateClientSettings(clientId));
}

function safeParseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

export async function getGlobalUiDefaults(): Promise<{ settings: string; version: number; updatedAt: number }> {
  const row = await getOrCreateClientSettings(GLOBAL_CLIENT_SETTINGS_ID);
  const safeSettings = JSON.stringify(sanitizeUiControlSettings(safeParseJson(row.uiGlobalSettingsJson ?? null) ?? DEFAULT_UI_CONTROL_SETTINGS));
  const safeVersion = Number.isFinite(Number(row.uiDefaultsVersion)) ? Number(row.uiDefaultsVersion) : UI_DEFAULTS_VERSION;
  if (safeSettings !== row.uiGlobalSettingsJson || safeVersion !== row.uiDefaultsVersion) {
    const updated = await updateClientSettings(GLOBAL_CLIENT_SETTINGS_ID, {
      uiGlobalSettingsJson: safeSettings,
      uiDefaultsVersion: safeVersion,
    });
    return { settings: updated.uiGlobalSettingsJson ?? safeSettings, version: Number(updated.uiDefaultsVersion ?? safeVersion), updatedAt: Number(updated.updatedAt) };
  }
  return { settings: row.uiGlobalSettingsJson ?? safeSettings, version: safeVersion, updatedAt: Number(row.updatedAt) };
}

export async function setGlobalUiDefaults(args: { settings: unknown; bumpVersion?: boolean }): Promise<{ settings: string; version: number; updatedAt: number }> {
  const current = await getGlobalUiDefaults();
  const safeSettings = JSON.stringify(sanitizeUiControlSettings(args.settings));
  const nextVersion = args.bumpVersion === false ? current.version : current.version + 1;
  const updated = await updateClientSettings(GLOBAL_CLIENT_SETTINGS_ID, {
    uiGlobalSettingsJson: safeSettings,
    uiDefaultsVersion: nextVersion,
  });
  return {
    settings: updated.uiGlobalSettingsJson ?? safeSettings,
    version: Number(updated.uiDefaultsVersion ?? nextVersion),
    updatedAt: Number(updated.updatedAt),
  };
}

export async function getGlobalWarehouseBomRelationSchema(): Promise<{ schemaJson: string; updatedAt: number }> {
  const row = await getOrCreateClientSettings(GLOBAL_CLIENT_SETTINGS_ID);
  const safeSchemaJson = JSON.stringify(sanitizeWarehouseBomRelationSchema(safeParseJson(row.bomRelationSchemaJson ?? null) ?? DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA));
  if (safeSchemaJson !== row.bomRelationSchemaJson) {
    const updated = await updateClientSettings(GLOBAL_CLIENT_SETTINGS_ID, {
      bomRelationSchemaJson: safeSchemaJson,
    });
    return { schemaJson: updated.bomRelationSchemaJson ?? safeSchemaJson, updatedAt: Number(updated.updatedAt) };
  }
  return { schemaJson: row.bomRelationSchemaJson ?? safeSchemaJson, updatedAt: Number(row.updatedAt) };
}

export async function setGlobalWarehouseBomRelationSchema(args: { schema: unknown }): Promise<{ schemaJson: string; updatedAt: number }> {
  const safeSchemaJson = JSON.stringify(sanitizeWarehouseBomRelationSchema(args.schema));
  const updated = await updateClientSettings(GLOBAL_CLIENT_SETTINGS_ID, {
    bomRelationSchemaJson: safeSchemaJson,
  });
  return {
    schemaJson: updated.bomRelationSchemaJson ?? safeSchemaJson,
    updatedAt: Number(updated.updatedAt),
  };
}

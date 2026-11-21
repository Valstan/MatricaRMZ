// ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ ПАРКА (владелец 21.11.2026):
// «если программа не перезапускается долгое время, а версии обновления ушли уже
//  на 2 версии вперёд — делать принудительное обновление программы в 12:30 по Москве».
//
// Механика доставки — УЖЕ СУЩЕСТВУЮЩАЯ: команда `reinstall` в слоте команды клиента
// (client_settings.sync_request_type). Её исполняет внешний сторож (watchdog/main.go),
// который опрашивает /client/settings раз в 15 минут, ставит свежий инсталлятор и
// подтверждает выполнение. Новый тип команды не заводим: `reinstall` работает на
// любой версии клиента (в т.ч. на 3.134.0, где её не понимает сам клиент) и не
// ломает слот команд.
//
// Правило отбора (кто обновляем) живёт в домене — shared/src/domain/forcedUpdate.ts.
// Здесь только серверная механика: собрать кандидатов, выдать команды, отчитаться.

import { randomUUID } from 'node:crypto';

import {
  FORCED_UPDATE_ALIVE_WINDOW_MS,
  FORCED_UPDATE_MIN_RELEASE_DISTANCE,
  FORCED_UPDATE_STALE_AFTER_MS,
  FORCED_UPDATE_WINDOW_HOUR_MSK,
  FORCED_UPDATE_WINDOW_MINUTE_MSK,
  clientHasWatchdog,
  clientMachineName,
  evaluateForcedUpdate,
  forcedUpdateWindow,
} from '@matricarmz/shared';

import { logInfo, logWarn } from '../utils/logger.js';
import { listClientSettings, setClientSyncRequest } from './clientSettingsService.js';
import { ingestServerCriticalEvent } from './criticalEventsService.js';
import { getInstanceRole, shouldRunBackgroundJobs } from './instanceRole.js';
import { getLatestUpdateFileMeta, getLatestUpdateFilePublishedAt } from './updateTorrentService.js';

/** Как часто джоба смотрит на часы. Окно 30 минут — проверки чаще не нужны. */
const FORCED_UPDATE_TICK_MS = 5 * 60 * 1000;

/** Правило владельца касается НАСТОЛЬНОЙ программы; планшетный клиент обновляется своим APK. */
const DESKTOP_PLATFORM = 'win32';

export type ForcedUpdateSweepResult = {
  ranAt: number;
  /** Релиз, на который выставляем обновление (null — на сервере нет инсталлятора). */
  latestVersion: string | null;
  /** Машины, которым выдана команда переустановки. */
  forced: { clientId: string; machine: string; from: string | null; releaseDistance: number | null }[];
  /** Машины, которые пропущены, с причиной. */
  skipped: { clientId: string; machine: string; reason: string }[];
  /** Сколько мёртвых команд в слоте клиента вытеснено этой выдачей. */
  replacedStaleRequests: number;
};

let timer: NodeJS.Timeout | null = null;
let lastRunDateKey: string | null = null;

/**
 * Один проход по парку: кому отстал релиз — выдаём команду переустановки.
 *
 * Идемпотентна: машина, у которой команда уже висит в слоте, повторно не трогается.
 */
export async function runForcedUpdateSweep(args?: { now?: number }): Promise<ForcedUpdateSweepResult> {
  const now = args?.now ?? Date.now();
  const meta = await getLatestUpdateFileMeta();
  if (!meta?.version) {
    logWarn('forced update sweep: на сервере нет инсталлятора — обновлять не к чему');
    return { ranAt: now, latestVersion: null, forced: [], skipped: [], replacedStaleRequests: 0 };
  }
  const latestVersion = meta.version;
  const publishedAt = await getLatestUpdateFilePublishedAt();
  const rows = await listClientSettings();

  const forced: ForcedUpdateSweepResult['forced'] = [];
  const skipped: ForcedUpdateSweepResult['skipped'] = [];
  let replacedStaleRequests = 0;

  for (const row of rows) {
    // Правило — про настольную программу: планшетный клиент обновляется своим APK.
    if (String(row.lastPlatform ?? '').trim() !== DESKTOP_PLATFORM) continue;
    const machine = clientMachineName({ clientId: row.clientId, hostname: row.lastHostname });
    const decision = evaluateForcedUpdate({
      candidate: {
        clientId: row.clientId,
        lastVersion: row.lastVersion ?? null,
        lastSeenAt: row.lastSeenAt ?? null,
        updatesEnabled: row.updatesEnabled,
        hasWatchdog: clientHasWatchdog(row.lastVersion),
        pendingRequestType: row.syncRequestType ?? null,
        pendingRequestAt: row.syncRequestAt ?? null,
      },
      latestVersion,
      now,
      latestPublishedAt: publishedAt,
    });
    if (!decision.forced) {
      skipped.push({ clientId: row.clientId, machine, reason: decision.reason });
      continue;
    }
    const payload = JSON.stringify({
      reason: 'forced-update',
      rule: 'owner-2026-11-21',
      latestVersion,
      releaseDistance: decision.releaseDistance,
      replacedStaleRequest: !!decision.replaceStaleRequest,
    });
    await setClientSyncRequest(row.clientId, {
      id: randomUUID(),
      type: 'reinstall',
      at: now,
      payload,
    });
    if (decision.replaceStaleRequest) replacedStaleRequests += 1;
    forced.push({
      clientId: row.clientId,
      machine,
      from: row.lastVersion ?? null,
      releaseDistance: decision.releaseDistance,
    });
    logInfo('forced update: команда переустановки выдана', {
      clientId: row.clientId,
      machine,
      from: row.lastVersion ?? null,
      to: latestVersion,
      releaseDistance: decision.releaseDistance,
      replacedStaleRequest: !!decision.replaceStaleRequest,
    });
  }

  logInfo('forced update sweep', {
    latestVersion,
    publishedAt,
    aliveWindowMs: FORCED_UPDATE_ALIVE_WINDOW_MS,
    minReleaseDistance: FORCED_UPDATE_MIN_RELEASE_DISTANCE,
    staleAfterMs: FORCED_UPDATE_STALE_AFTER_MS,
    forced: forced.length,
    skipped: skipped.length,
    replacedStaleRequests,
  });

  if (forced.length > 0) {
    const dateKey = forcedUpdateWindow(now).dateKey;
    const machines = forced.map((f) => `${f.machine} (${f.from ?? '?'} → ${latestVersion})`).join(', ');
    ingestServerCriticalEvent({
      eventCode: 'client.forced_update_sweep',
      title: 'Парк: принудительное обновление отставших машин',
      humanMessage:
        `По правилу владельца (отставание от последнего релиза не меньше ${FORCED_UPDATE_MIN_RELEASE_DISTANCE} версий) ` +
        `${dateKey} в ${FORCED_UPDATE_WINDOW_HOUR_MSK}:${String(FORCED_UPDATE_WINDOW_MINUTE_MSK).padStart(2, '0')} МСК ` +
        `обновление получили ${forced.length} машин: ${machines}.`,
      category: 'other',
      severity: 'warn',
      dedupMessage: `forced-update-sweep:${dateKey}:${forced.length}`,
    });
  }

  return { ranAt: now, latestVersion, forced, skipped, replacedStaleRequests };
}

/**
 * Фоновая джоба: раз в 5 минут смотрим на часы по Москве и, если открылось окно
 * 12:30, делаем один проход по парку. Проход в день — один (по ключу даты МСК),
 * чтобы не выдавать команду второй раз машинам, которые её уже выполнили.
 */
export function startForcedUpdateJob() {
  if (timer) return;
  if (!shouldRunBackgroundJobs(getInstanceRole())) {
    logInfo('forced update job skipped on non-primary instance');
    return;
  }
  const tick = () => {
    const now = Date.now();
    const win = forcedUpdateWindow(now);
    if (!win.open) return;
    if (lastRunDateKey === win.dateKey) return;
    lastRunDateKey = win.dateKey;
    runForcedUpdateSweep({ now }).catch((e) => {
      lastRunDateKey = null;
      logWarn('forced update sweep failed', { error: String(e) });
    });
  };
  timer = setInterval(tick, FORCED_UPDATE_TICK_MS);
  timer.unref?.();
  setTimeout(tick, 30_000).unref?.();
}

export function stopForcedUpdateJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastRunDateKey = null;
}

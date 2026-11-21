// ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ ПАРКА (владелец 21.11.2026):
// «если программа не перезапускается долгое время, а версии обновления ушли уже
//  на 2 версии вперёд — делать принудительное обновление программы в 12:30 по Москве».
//
// Правило живёт здесь, в домене, потому что его читают три независимых места:
// серверная джоба (кого и когда обновлять), тесты и отчёт владельцу. Смысл:
//
//   1. Отставание считаем ПО РЕЛИЗАМ, а не по semver: нумерация программы сменила
//      три схемы (см. appVersion.ts), и сравнение «3.140.0 против 2026.814.1503»
//      числами даёт откат вместо отставания.
//   2. «Не перезапускается долгое время» — это не отдельная метрика, а следствие:
//      клиент жив (свежий heartbeat) и до сих пор на старой версии, то есть новый
//      релиз он уже видел и не взял. Свежесть самого релиза (когда он появился на
//      сервере) ограничивает правило: свежий релиз машине не вменяем.
//   3. Окно 12:30 считаем по МСК (UTC+3) независимо от TZ процесса — бокс живёт в
//      Europe/Moscow, но код не должен на это зависеть.

import { compareAppVersion, parseGenerationVersion, versionEpoch } from './appVersion.js';

/** На сколько релизов клиент должен отстать, чтобы его можно было обновлять принудительно. */
export const FORCED_UPDATE_MIN_RELEASE_DISTANCE = 2;

/** Свежесть heartbeat'а, за которой клиент считается живым (его программа запущена). */
export const FORCED_UPDATE_ALIVE_WINDOW_MS = 60 * 60 * 1000;

/** Сколько релиз должен пролежать на сервере, прежде чем отставание машины станет «долгим». */
export const FORCED_UPDATE_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/** Окно принудительного обновления по Москве: 12:30. */
export const FORCED_UPDATE_WINDOW_HOUR_MSK = 12;
export const FORCED_UPDATE_WINDOW_MINUTE_MSK = 30;

/** Длина окна в минутах (12:30–13:00 МСК). */
export const FORCED_UPDATE_WINDOW_MINUTES = 30;

/** Смещение Москвы от UTC в минутах. */
export const MSK_UTC_OFFSET_MINUTES = 180;

/**
 * Отставание, когда точное число релизов неизмеримо (другое поколение нумерации
 * или клиент на прежней схеме). Значение заведомо больше любого порога: такой
 * клиент позади целиком.
 */
export const RELEASE_DISTANCE_UNMEASURABLE = 10_000;

/**
 * Сколько команд в слоте клиента можно вытеснить: команда, висящая дольше этого,
 * считается мёртвой (реальный случай — `reset_sync_state_and_pull` с сентября,
 * блокирующий доставку обновления).
 */
export const FORCED_UPDATE_STALE_REQUEST_MS = 12 * 60 * 60 * 1000;

/**
 * На сколько релизов клиент отстал от последнего релиза.
 *
 * null — версии несравнимы (клиент не сообщил версию или она не разбирается).
 * 0 — клиент актуален либо новее сервера.
 */
export function releaseDistance(clientVersion: string, latestVersion: string): number | null {
  const client = String(clientVersion ?? '').trim();
  const latest = String(latestVersion ?? '').trim();
  const clientParts = parseGenerationVersion(client);
  const latestParts = parseGenerationVersion(latest);
  if (clientParts && latestParts) {
    if (clientParts.generation !== latestParts.generation) {
      // Счётчик нового поколения начинается с нуля, поэтому точное число релизов
      // между поколениями неизмеримо. Клиент из прошлого поколения позади целиком.
      return clientParts.generation < latestParts.generation ? RELEASE_DISTANCE_UNMEASURABLE : 0;
    }
    return Math.max(0, latestParts.release - clientParts.release);
  }
  // Клиент на прежней схеме нумерации (CalVer/1.x) — он позади всего поколения 3.x.
  if (versionEpoch(client) === null || versionEpoch(latest) === null) return null;
  return compareAppVersion(client, latest) < 0 ? RELEASE_DISTANCE_UNMEASURABLE : 0;
}

export type ForcedUpdateCandidate = {
  /** Идентификатор машины (client_id). */
  clientId: string;
  /** Версия, которую клиент последний раз сообщил серверу. */
  lastVersion: string | null;
  /** Последний heartbeat клиента (epoch ms); null — клиент ни разу не откликался. */
  lastSeenAt: number | null;
  /** Обновления для машины не выключены администратором. */
  updatesEnabled: boolean;
  /** На машине есть сторож: иначе команду переустановки никто не заберёт. */
  hasWatchdog: boolean;
  /** Что сейчас лежит в слоте команды клиента (тип команды). */
  pendingRequestType?: string | null;
  /** Когда команда в слоте появилась (epoch ms). */
  pendingRequestAt?: number | null;
};

export type ForcedUpdateReason =
  | 'forced'
  | 'up-to-date'
  | 'within-distance'
  | 'version-unknown'
  | 'client-offline'
  | 'updates-disabled'
  | 'no-watchdog'
  | 'already-commanded'
  | 'request-busy'
  | 'release-too-fresh';

export type ForcedUpdateDecision = {
  /** Обновлять машину принудительно прямо сейчас. */
  forced: boolean;
  /** Почему решение такое — для лога и отчёта. */
  reason: ForcedUpdateReason;
  /** На сколько релизов клиент отстал (null — версии несравнимы). */
  releaseDistance: number | null;
  /** Слот команды клиента занят мёртвой командой — её можно вытеснить. */
  replaceStaleRequest?: boolean;
};

/**
 * Решение по одной машине: обновлять ли её принудительно.
 *
 * Порядок проверок — от «точно не обновляем» к «точно обновляем», чтобы причина
 * отказа в логе всегда была первой настоящей, а не последней.
 */
export function evaluateForcedUpdate(args: {
  candidate: ForcedUpdateCandidate;
  /** Последний релиз, который отдаёт сервер. */
  latestVersion: string;
  /** Текущее время (epoch ms). */
  now: number;
  /** Когда релиз появился на сервере (epoch ms) — undefined/null — неизвестно. */
  latestPublishedAt?: number | null;
  minReleaseDistance?: number;
  aliveWindowMs?: number;
  staleAfterMs?: number;
  staleRequestMs?: number;
}): ForcedUpdateDecision {
  const { candidate } = args;
  const minDistance = args.minReleaseDistance ?? FORCED_UPDATE_MIN_RELEASE_DISTANCE;
  const aliveWindowMs = args.aliveWindowMs ?? FORCED_UPDATE_ALIVE_WINDOW_MS;
  const staleAfterMs = args.staleAfterMs ?? FORCED_UPDATE_STALE_AFTER_MS;
  const staleRequestMs = args.staleRequestMs ?? FORCED_UPDATE_STALE_REQUEST_MS;

  const distance = releaseDistance(String(candidate.lastVersion ?? ''), args.latestVersion);
  if (distance === null) {
    return { forced: false, reason: 'version-unknown', releaseDistance: null };
  }
  if (distance === 0) {
    return { forced: false, reason: 'up-to-date', releaseDistance: distance };
  }
  if (distance < minDistance) {
    return { forced: false, reason: 'within-distance', releaseDistance: distance };
  }
  if (!candidate.updatesEnabled) {
    return { forced: false, reason: 'updates-disabled', releaseDistance: distance };
  }
  if (candidate.lastSeenAt == null || args.now - candidate.lastSeenAt > aliveWindowMs) {
    // Машина молчит: её программа не запущена или выключен компьютер. Будить
    // выключенные ПК посреди ночи правило владельца не требует.
    return { forced: false, reason: 'client-offline', releaseDistance: distance };
  }
  if (!candidate.hasWatchdog) {
    // Команду переустановки доставляет только сторож; у клиента без сторожа она
    // осталась бы висеть в слоте навсегда.
    return { forced: false, reason: 'no-watchdog', releaseDistance: distance };
  }

  const pendingType = String(candidate.pendingRequestType ?? '').trim();
  if (pendingType === 'reinstall') {
    return { forced: false, reason: 'already-commanded', releaseDistance: distance };
  }
  let replaceStaleRequest = false;
  if (pendingType) {
    const requestAge = candidate.pendingRequestAt == null ? null : args.now - candidate.pendingRequestAt;
    if (requestAge === null || requestAge < staleRequestMs) {
      // Слот занят живой чужой командой — вытеснять её нельзя.
      return { forced: false, reason: 'request-busy', releaseDistance: distance };
    }
    replaceStaleRequest = true;
  }

  if (args.latestPublishedAt != null && args.now - args.latestPublishedAt < staleAfterMs) {
    // Релиз свежий: машина ещё не могла его взять — «не перезапускается долгое
    // время» про неё говорить рано.
    return { forced: false, reason: 'release-too-fresh', releaseDistance: distance };
  }

  return { forced: true, reason: 'forced', releaseDistance: distance, replaceStaleRequest };
}

export type ForcedUpdateWindow = {
  /** Окно открыто прямо сейчас. */
  open: boolean;
  /** Дата по МСК (YYYY-MM-DD) — ключ «сегодняшнего прохода». */
  dateKey: string;
  /** Минут до начала окна (0 — окно открыто). */
  minutesUntilStart: number;
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Окно принудительного обновления по Москве. Время считается по фиксированному
 * смещению UTC+3, а не по TZ процесса: правило владельца привязано к Москве.
 */
export function forcedUpdateWindow(
  now: number,
  opts?: { hour?: number; minute?: number; durationMinutes?: number; offsetMinutes?: number },
): ForcedUpdateWindow {
  const offsetMinutes = opts?.offsetMinutes ?? MSK_UTC_OFFSET_MINUTES;
  const hour = opts?.hour ?? FORCED_UPDATE_WINDOW_HOUR_MSK;
  const minute = opts?.minute ?? FORCED_UPDATE_WINDOW_MINUTE_MSK;
  const durationMinutes = opts?.durationMinutes ?? FORCED_UPDATE_WINDOW_MINUTES;

  const local = new Date(now + offsetMinutes * 60_000);
  const dateKey = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
  const minutesOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = hour * 60 + minute;
  const end = start + durationMinutes;
  const open = minutesOfDay >= start && minutesOfDay < end;
  const minutesUntilStart = open ? 0 : minutesOfDay < start ? start - minutesOfDay : 24 * 60 - minutesOfDay + start;
  return { open, dateKey, minutesUntilStart };
}

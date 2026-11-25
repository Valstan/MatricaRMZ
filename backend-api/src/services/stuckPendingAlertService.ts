/**
 * Аларм «очередь отправки на сервер застряла» — поднимается на сервере и уходит
 * владельцу сразу в три места: в чат программы, в раздел «Критические события» и
 * во внешние каналы (Telegram, МАКС).
 *
 * Почему аларм поднимает сервер, а не клиент: сервер и так видит очередь каждой
 * машины — она приезжает снимком диагностики раз в 10 минут. Значит тревога
 * поднимется даже там, где оператор ни разу не нажал кнопку; кнопка в баннере
 * лишь форсирует её немедленно (тот же вызов с `trigger: 'manual'`).
 *
 * Кто виноват и что делать — в отчёте: машина, время, оператор, потабличный разбор
 * (что именно не уходит), последняя ошибка синка и версия программы. Отчёт
 * собирается ОДИН раз (`formatStuckPendingReport`) и уходит теми же словами во
 * все каналы: расхождение чисел между каналами путает («в чате 617, в телеге 600»).
 */
import { formatStuckPendingReport, type StuckPendingReport, type StuckPendingTableStat } from '@matricarmz/shared';

import { ingestClientCriticalEvent } from './criticalEventsService.js';
import {
  ensureMonitoringRoom,
  postChatMessageToRoom,
  postChatMessageToSuperadmin,
} from './chatMessageService.js';
import { resolveLoginsToFullNames, getSuperadminUserId } from './employeeAuthService.js';
import { logInfo, logWarn } from '../utils/logger.js';

/** Код события — по нему и в журнале событий, и в гейтах видно, о чём речь. */
export const STUCK_PENDING_EVENT_CODE = 'client.sync.stuck_pending';

/**
 * Не чаще одного аларма на машину за это окно. Снимок диагностики приходит раз в
 * 10 минут, а очередь может висеть сутками — без окна владелец получил бы десятки
 * одинаковых сообщений и перестал бы их читать.
 */
const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60_000;

/**
 * Пол запрета для ручной кнопки: оператор жмёт «сообщить администратору» — и жмёт
 * один раз, а не десять. Две минуты — и повтор пройдёт, и кнопку не зальют.
 */
const DEFAULT_MANUAL_COOLDOWN_MS = 2 * 60_000;

const lastAlertAtByClient = new Map<string, { auto: number; manual: number }>();

/** Имя машины из clientId: формат `<hostname>-<uuid>`. */
export function clientNameFromClientId(clientId: string): string {
  const value = String(clientId ?? '').trim();
  if (!value) return '';
  const parts = value.split('-');
  // uuid состоит из 5 кусков через дефис — режем только префикс до него.
  if (parts.length < 6) return value;
  const name = parts.slice(0, parts.length - 5).join('-');
  return name || value;
}

export type StuckPendingAlertInput = {
  /** Кто сообщает: id и логин оператора (или суперадмина, если тревога автоматом). */
  actor: { id: string; username: string; role?: string | null };
  clientId: string;
  /** Человеческое имя машины; если пусто — берётся из clientId. */
  clientName?: string | null;
  stuck: StuckPendingReport;
  trigger: 'auto' | 'manual';
  appVersion?: string | null;
  /** ФИО оператора; сервер знает его по логину, клиент — нет. */
  operatorFullName?: string | null;
  operatorPosition?: string | null;
  /** Когда снят отчёт (unix-мс); по умолчанию — текущее время. */
  detectedAt?: number;
  /** Не ждать окна (кнопка оператора). */
  force?: boolean;
  /** Окно анти-флуда для автоматического аларма, мс (для тестов). */
  cooldownMs?: number;
  /** Пол запрета для ручной кнопки, мс (для тестов). */
  manualCooldownMs?: number;
};

export type StuckPendingAlertResult = {
  ok: boolean;
  /** Тревога ушла (в чат и в журнал событий). */
  alerted: boolean;
  /** Почему не ушла (окно анти-флуда, нет суперадмина и т.п.). */
  reason?: string;
  /** Текст отчёта — его показываем оператору в ответе. */
  text: string;
  /** Ушло ли сообщение в чат программы. */
  chatSent: boolean;
};

/**
 * Поднять аларм. Один вызов — один отчёт: и в чат, и в журнал событий (а оттуда
 * во внешние каналы), иначе числа в каналах разойдутся.
 */
export async function raiseStuckPendingAlert(input: StuckPendingAlertInput): Promise<StuckPendingAlertResult> {
  const clientId = String(input.clientId ?? '').trim();
  const cooldownMs = Number.isFinite(input.cooldownMs) ? Number(input.cooldownMs) : DEFAULT_ALERT_COOLDOWN_MS;
  const now = Number.isFinite(input.detectedAt) ? Number(input.detectedAt) : Date.now();

  let fullName = String(input.operatorFullName ?? '').trim();
  let position = String(input.operatorPosition ?? '').trim();
  if (!fullName) {
    const usernames = String(input.actor?.username ?? '').trim();
    if (usernames) {
      const names = (await resolveLoginsToFullNames([usernames]).catch(() => ({}))) as Record<string, string>;
      fullName = String(names[usernames.trim().toLowerCase()] ?? '').trim();
    }
  }

  const clientName = String(input.clientName ?? '').trim() || clientNameFromClientId(clientId);
  const text = formatStuckPendingReport({
    clientId,
    clientName,
    operator: {
      username: input.actor?.username ?? null,
      fullName: fullName || null,
      position: position || null,
    },
    stuck: input.stuck,
    detectedAt: now,
    trigger: input.trigger,
    appVersion: input.appVersion ?? null,
  });

  if (!input.force) {
    const last = lastAlertAtByClient.get(clientId)?.auto ?? 0;
    if (last > 0 && now - last < cooldownMs) {
      return {
        ok: true,
        alerted: false,
        reason: `аларм по этой машине уже был ${Math.round((now - last) / 60_000)} мин назад (окно ${Math.round(cooldownMs / 60_000)} мин)`,
        text,
        chatSent: false,
      };
    }
  } else {
    // Кнопку можно жать часто (оператор волнуется) — но и залить её нельзя.
    const last = lastAlertAtByClient.get(clientId)?.manual ?? 0;
    const manualCooldownMs = Number.isFinite(input.manualCooldownMs) ? Number(input.manualCooldownMs) : DEFAULT_MANUAL_COOLDOWN_MS;
    if (last > 0 && now - last < manualCooldownMs) {
      return {
        ok: true,
        alerted: false,
        reason: `сообщение по этой машине уже отправлялось ${Math.round((now - last) / 1000)} с назад — подождите минуту`,
        text,
        chatSent: false,
      };
    }
  }

  // 1. Журнал критических событий: отсюда событие забирают внешние каналы
  //    (Telegram, МАКС) и оно же видно в разделе «Критические события».
  try {
    ingestClientCriticalEvent({
      eventCode: STUCK_PENDING_EVENT_CODE,
      title: 'Очередь отправки на сервер застряла',
      humanMessage: text,
      category: 'sync',
      severity: 'error',
      clientId,
      username: input.actor?.username ?? null,
      aiDetails: {
        trigger: input.trigger,
        count: input.stuck.count,
        oldestPendingAt: input.stuck.oldestPendingAt,
        byTable: input.stuck.byTable,
        lastError: input.stuck.lastError ?? null,
        lastSyncAt: input.stuck.lastSyncAt ?? null,
        appVersion: input.appVersion ?? null,
      },
      // Отпечаток — по машине и счёту строк: новый отчёт той же машины с БОЛЬШИМ
      // счётком — это новая беда, а не повтор, и его пропускать нельзя.
      dedupMessage: `${clientId}|${input.stuck.count}`,
    });
  } catch (e) {
    logWarn('stuck pending alert: не удалось записать событие', { clientId, error: String(e) });
  }

  // 2. Чат программы: тревога падает в комнату «Мониторинг завода» — там она не
  //    теряется в ленте личных писем, а в комнату можно позвать заместителя
  //    администратора. Если комнату завести не вышло (нет супер-админа) — пишем
  //    лично супер-админу: лучше личное письмо, чем молчание.
  let chatSent = false;
  let chatRoomId: string | null = null;
  try {
    chatRoomId = await ensureMonitoringRoom();
    if (chatRoomId) {
      // Тревога — событие СИСТЕМЫ, а не письмо оператора: отправляем её от владельца
      // комнаты (супер-админа). Раньше отправляли от имени оператора, а он не состоит
      // в комнате тревог ⇒ запись отбивалась гейтом (`sync_policy_denied:
      // chat_room_member`) ⇒ ни кнопка «сообщить администратору», ни авто-аларм до
      // администратора не доходили (инцидент PC63, 25.11.2026: 14 тревог за день —
      // все мимо комнаты). В тексте отчёта оператор назван отдельно.
      const superadminId = await getSuperadminUserId();
      const roomOwner =
        superadminId && superadminId !== String(input.actor?.id ?? '')
          ? { id: superadminId, username: 'мониторинг', role: 'superadmin' }
          : {
              id: String(input.actor?.id ?? ''),
              username: String(input.actor?.username ?? ''),
              role: input.actor?.role ?? 'user',
            };
      const sent = await postChatMessageToRoom({
        roomId: chatRoomId,
        senderUserId: roomOwner.id,
        senderUsername: roomOwner.username,
        text,
        actor: {
          id: roomOwner.id,
          username: roomOwner.username,
          role: roomOwner.role,
        },
      });
      chatSent = sent.ok;
      if (!sent.ok) logWarn('stuck pending alert: сообщение в комнату не отправлено', { clientId, error: sent.error });
    } else {
      const sent = await postChatMessageToSuperadmin({
        senderUserId: String(input.actor?.id ?? ''),
        senderUsername: String(input.actor?.username ?? ''),
        text,
        actor: {
          id: String(input.actor?.id ?? ''),
          username: String(input.actor?.username ?? ''),
          role: input.actor?.role ?? 'user',
        },
      });
      chatSent = sent.ok;
      if (!sent.ok) logWarn('stuck pending alert: сообщение в чат не отправлено', { clientId, error: sent.error });
    }
  } catch (e) {
    logWarn('stuck pending alert: сообщение в чат упало', { clientId, error: String(e) });
  }

  const prev = lastAlertAtByClient.get(clientId) ?? { auto: 0, manual: 0 };
  lastAlertAtByClient.set(clientId, {
    auto: input.trigger === 'auto' ? now : prev.auto,
    manual: input.trigger === 'manual' ? now : prev.manual,
  });
  logInfo('stuck pending alert', { clientId, count: input.stuck.count, trigger: input.trigger, chatSent }, { critical: true });
  return { ok: true, alerted: true, text, chatSent };
}

/** Сброс окна анти-флуда (тесты, смена машины на том же clientId). */
export function resetStuckPendingAlertCooldown(): void {
  lastAlertAtByClient.clear();
}

/**
 * Отчёт о застрявшей очереди из снимка диагностики клиента.
 *
 * Снимок уже несёт потабличные счётчики застрявших строк (`stuckCount`,
 * `oldestPendingAt`) — значит автоматическому аларму не нужен отдельный опрос
 * клиента: он поднимается на том же снимке, что и сверка данных.
 *
 * `null` — застрявших строк нет (аларма не будет).
 */
export function stuckPendingReportFromSnapshotTables(
  tables: Record<string, unknown> | null | undefined,
  thresholdMinutes: number,
): StuckPendingReport | null {
  const byTable: StuckPendingTableStat[] = [];
  let count = 0;
  let oldestPendingAt: number | null = null;
  for (const [table, raw] of Object.entries(tables ?? {})) {
    const section = (raw ?? {}) as { stuckCount?: unknown; oldestPendingAt?: unknown };
    const n = Number(section.stuckCount ?? 0);
    if (!(n > 0)) continue;
    const oldest = section.oldestPendingAt == null ? null : Number(section.oldestPendingAt);
    byTable.push({ table, n, oldestPendingAt: oldest });
    count += n;
    if (oldest != null && (oldestPendingAt == null || oldest < oldestPendingAt)) oldestPendingAt = oldest;
  }
  if (count <= 0) return null;
  return { count, oldestPendingAt, thresholdMinutes, byTable };
}

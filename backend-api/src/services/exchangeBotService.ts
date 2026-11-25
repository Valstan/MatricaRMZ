/**
 * Бот обмена и пересылки — серверное правило.
 *
 * Задача бота (зачитка владельца 25.11.2026, промт КАРМАНА #143): оператор пишет
 * боту с телефона, прикладывает файл, бот называет, ГДЕ находится отправитель и КОМУ
 * отправляет, и отправляет.
 *
 * Кто такой бот: отдельной сущности «бот» в программе нет, и заводить её не нужно.
 * Бот — это правило в чате, которое говорит голосом учётной записи супер-администратора
 * с именем «Бот обмена» (ровно как бота тревог, который пишет в комнату «Мониторинг
 * завода» от владельца комнаты). Отдельная комната для бота НЕ заводится намеренно:
 * диалог бота — один на один (вопрос → ответ), а комната потребовала бы управления
 * составом участников ради единственной переписки.
 *
 * Где живёт «личность» бота: в переписке с администратором. Ответы бота приходят
 * оператору личным сообщением от «Бот обмена» — их видно и оператору, и администратору
 * (прозрачность: кто что переслал).
 *
 * Транспорт пересылки — ТОТ ЖЕ, что у уже работающей передачи файлов между Верстаками:
 * личное сообщение чата с файлом. Оно и синхронизируется получателю, и выдаёт ему
 * доступ к файлу (`chatPayloadGrantsFileAccess`). Своей таблицы нет намеренно.
 *
 * Проверка доступа к файлу НЕ обходится: переслать можно только то, к чему у
 * отправителя есть доступ (`canAccessFile`) — ровно как в «отправить коллеге».
 */
import { and, desc, eq, gte, isNull } from 'drizzle-orm';

import {
  EXCHANGE_BOT_EVENT_CODE,
  EXCHANGE_BOT_MACHINE_ALIVE_WINDOW_DAYS,
  EXCHANGE_BOT_MAX_CANDIDATES,
  EXCHANGE_BOT_REQUEST_WINDOW_MS,
  EXCHANGE_BOT_USERNAME,
  buildExchangeBotQuestion,
  buildExchangeBotSentText,
  exchangeDeviceKind,
  parseExchangeBotChoice,
  pickExchangeBotCandidate,
  sortExchangeBotCandidates,
  type ExchangeDeviceKind,
  type ExchangeMachineCandidate,
  type ExchangeSenderMachine,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { chatMessages, clientSettings, fileAssets } from '../database/schema.js';
import { ingestClientCriticalEvent } from './criticalEventsService.js';
import { getSuperadminUserId, listEmployeesAuth } from './employeeAuthService.js';
import { canAccessFile } from './fileAccessService.js';
import { postChatMessage } from './chatMessageService.js';
import { logInfo, logWarn } from '../utils/logger.js';

/** Что прислал клиент, чтобы серверу принять решение. */
export type ExchangeBotTrigger = {
  /** Кто пишет. */
  actor: { id: string; username: string; role?: string | null };
  /** Сообщение, которое оператор отправил боту. */
  messageId: string;
  /** Кому оно адресовано. Бот отвечает только на свои адреса. */
  recipientUserId: string;
  /** Машина отправителя: id, имя, тип устройства. */
  clientId?: string | null;
  clientName?: string | null;
  deviceKind?: string | null;
  appVersion?: string | null;
  /** Файл запроса (клиент знает его раньше сервера — сообщение ещё могло не уехать). */
  fileId?: string | null;
  fileName?: string | null;
  /** Подсказка клиента: какой файл ждёт ответа (последний отправленный боту). */
  pendingFileId?: string | null;
  /** Когда клиент отправил этот файл (unix-мс) — по нему сужается окно ответа. */
  pendingFileSentAt?: number | null;
  /** Текст сообщения (если это не файл). */
  text?: string | null;
};

export type ExchangeBotActionResult = {
  ok: boolean;
  /** Бот что-то сделал (задал вопрос, переслал файл, объяснил, почему не смог). */
  acted: boolean;
  /** Текст ответа бота (если бот отвечал). */
  reply?: string | null;
  /** Почему бот промолчал. */
  reason?: string;
  /** Ошибка (не сработало). */
  error?: string;
};

/**
 * Предел флуда: оператор не должен превратить бота в рассылку.
 *
 * Окно — минута на оператора: десять обращений в минуту — это уже не диалог, а
 * поток, и каждое из них пишет в переписку получателя. Предел мягкий: лишнее
 * обращение просто игнорируется (без записи в журнал событий).
 */
const FLOOD_WINDOW_MS = 60_000;
const FLOOD_MAX_PER_WINDOW = 10;
const floodHits = new Map<string, number[]>();

function floodBlocked(actorId: string, now: number): boolean {
  const hits = (floodHits.get(actorId) ?? []).filter((t) => now - t < FLOOD_WINDOW_MS);
  hits.push(now);
  floodHits.set(actorId, hits);
  if (floodHits.size > 500) floodHits.clear();
  return hits.length > FLOOD_MAX_PER_WINDOW;
}

/** Сброс предела флуда (тесты). */
export function resetExchangeBotFloodGuard(): void {
  floodHits.clear();
}

/** Полный `FileRef` — как его кладёт в сообщение клиент. */
type FileRefLike = {
  id: string;
  name: string;
  size: number;
  mime: string | null;
  sha256: string;
  createdAt: number;
};

function parseFileRef(payloadJson: string | null | undefined): FileRefLike | null {
  if (!payloadJson) return null;
  try {
    const raw = JSON.parse(payloadJson) as Record<string, unknown>;
    const id = String(raw?.id ?? '').trim();
    if (!id) return null;
    return {
      id,
      name: String(raw?.name ?? '').trim() || 'Файл',
      size: Number(raw?.size ?? 0) || 0,
      mime: raw?.mime == null ? null : String(raw.mime),
      sha256: String(raw?.sha256 ?? ''),
      createdAt: Number(raw?.createdAt ?? 0) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Тип машины по платформе клиента.
 *
 * `client_settings.last_platform` — это платформа ОС (`win32`, `android`, …), а не
 * наш доменный тип: переводим здесь, один раз.
 */
export function deviceKindFromPlatform(platform: string | null | undefined): ExchangeDeviceKind {
  const p = String(platform ?? '').trim().toLowerCase();
  if (p === 'win32' || p === 'darwin' || p === 'linux') return 'computer';
  // Android — это и планшет, и телефон; различать их программа не умеет, поэтому
  // называем «планшет» (на планшет и ставится APK).
  if (p === 'android' || p === 'ios') return 'tablet';
  return 'other';
}

/**
 * Машины-получатели: реестр машин парка (`client_settings`) + кто на них авторизован.
 *
 * Источник один — `client_settings.last_username`: это логин, под которым на
 * машине последний раз вошли в программу. Отдельного реестра «машина → человек»
 * в программе нет, и это ограничение названо владельцу: бот называет машину её
 * именем (hostname) и тем, кто на ней авторизован.
 */
export async function resolveExchangeBotMachines(input: {
  senderLogin: string;
  currentClientId?: string | null;
  /** Имя текущей машины — из клиента (он знает своё имя точно). */
  currentClientName?: string | null;
  /** Тип текущей машины — из клиента. */
  currentDeviceKind?: string | null;
  now?: number;
}): Promise<{ candidates: ExchangeMachineCandidate[]; currentMachine: ExchangeSenderMachine | null }> {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const since = now - EXCHANGE_BOT_MACHINE_ALIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const rows = await db
    .select({
      clientId: clientSettings.clientId,
      hostname: clientSettings.lastHostname,
      platform: clientSettings.lastPlatform,
      username: clientSettings.lastUsername,
      lastSeenAt: clientSettings.lastSeenAt,
    })
    .from(clientSettings)
    .where(gte(clientSettings.lastSeenAt, since))
    .limit(2000);

  const employees = await listEmployeesAuth();
  const byLogin = new Map<string, { id: string; fullName: string }>();
  if (employees.ok) {
    for (const r of employees.rows) {
      const login = String(r.login ?? '').trim().toLowerCase();
      if (!login) continue;
      const fullName = String(r.chatDisplayName ?? '').trim() || String(r.fullName ?? '').trim() || String(r.login ?? '').trim();
      byLogin.set(login, { id: String(r.id), fullName });
    }
  }

  const senderLogin = String(input.senderLogin ?? '').trim().toLowerCase();
  const currentClientId = String(input.currentClientId ?? '').trim();
  const currentKind = exchangeDeviceKind(input.currentDeviceKind);

  let currentMachine: ExchangeSenderMachine | null = null;
  const candidates: ExchangeMachineCandidate[] = [];

  for (const row of rows) {
    const clientId = String(row.clientId ?? '').trim();
    if (!clientId) continue;
    const hostname = String(row.hostname ?? '').trim() || clientId.slice(0, 8);
    const deviceKind = deviceKindFromPlatform(row.platform);

    if (clientId === currentClientId) {
      currentMachine = { machineName: hostname, deviceKind, clientId };
      continue;
    }
    // Машина без авторизованного человека пересылать нельзя: получателя нет.
    const login = String(row.username ?? '').trim();
    const loginKey = login.toLowerCase();
    const person = loginKey ? byLogin.get(loginKey) ?? null : null;
    if (!person) continue;

    candidates.push({
      clientId,
      machineName: hostname,
      deviceKind,
      login: login || null,
      userName: person.fullName || null,
      userId: person.id,
      isCurrent: false,
      isOwn: Boolean(senderLogin) && loginKey === senderLogin,
      lastSeenAt: row.lastSeenAt == null ? null : Number(row.lastSeenAt),
    });
  }

  // Текущей машины может не быть в реестре (например, её heartbeat ещё не дошёл) —
  // тогда верим клиенту: он знает своё имя и тип.
  if (!currentMachine && currentClientId) {
    const name = String(input.currentClientName ?? '').trim();
    if (name) {
      currentMachine = { machineName: name, deviceKind: currentKind, clientId: currentClientId };
    }
  }

  const sorted = sortExchangeBotCandidates(candidates).slice(0, EXCHANGE_BOT_MAX_CANDIDATES);
  return { candidates: sorted, currentMachine };
}

/** Имя файла по id — клиент знает его не всегда (например, отправка файла в чат). */
async function fileNameById(fileId: string): Promise<string> {
  const rows = await db
    .select({ name: fileAssets.name })
    .from(fileAssets)
    .where(eq(fileAssets.id, fileId as any))
    .limit(1);
  return String(rows[0]?.name ?? '').trim();
}

/** Ответить оператору от имени бота. */
async function replyAsBot(recipientUserId: string, text: string): Promise<void> {
  const botId = await getSuperadminUserId();
  if (!botId) return;
  await postChatMessage({
    senderUserId: botId,
    senderUsername: EXCHANGE_BOT_USERNAME,
    recipientUserId,
    text,
    actor: { id: botId, username: EXCHANGE_BOT_USERNAME, role: 'superadmin' },
  });
}

/**
 * Переслать файл получателю — личным сообщением чата с файлом.
 *
 * Проверка доступа отправителя обязательна: бот пересылает файл, который прислал
 * оператор, и не должен стать обходом проверки доступа (`canAccessFile` — тот же
 * гейт, что у «отправить коллеге»).
 */
async function forwardFileToCandidate(args: {
  actor: { id: string; username: string; role?: string | null };
  fileId: string;
  candidate: ExchangeMachineCandidate;
  senderName?: string | null;
}): Promise<{ ok: true; fileName: string } | { ok: false; error: string }> {
  const fileRows = await db
    .select()
    .from(fileAssets)
    .where(and(eq(fileAssets.id, args.fileId as any), isNull(fileAssets.deletedAt)))
    .limit(1);
  const file = fileRows[0] as any;
  if (!file) return { ok: false, error: 'файл не найден на сервере' };

  const allowed = await canAccessFile(args.actor, {
    id: String(file.id),
    createdByUserId: file.createdByUserId ?? null,
  });
  if (!allowed) return { ok: false, error: 'доступ к файлу запрещён' };

  const payload: FileRefLike = {
    id: String(file.id),
    name: String(file.name ?? 'Файл'),
    size: Number(file.size ?? 0) || 0,
    mime: file.mime ? String(file.mime) : null,
    sha256: String(file.sha256 ?? ''),
    createdAt: Number(file.createdAt ?? 0) || 0,
  };

  const botId = await getSuperadminUserId();
  if (!botId) return { ok: false, error: 'в системе нет супер-администратора' };
  if (!args.candidate.userId) return { ok: false, error: 'у машины получателя нет пользователя' };

  const sent = await postChatMessage({
    senderUserId: botId,
    senderUsername: EXCHANGE_BOT_USERNAME,
    recipientUserId: args.candidate.userId,
    text: payload.name,
    messageType: 'file',
    payload,
    actor: { id: botId, username: EXCHANGE_BOT_USERNAME, role: 'superadmin' },
  });
  if (!sent.ok) return { ok: false, error: sent.error };
  return { ok: true, fileName: payload.name };
}

/** Последний файл, присланный боту этим оператором (и не старше окна ответа). */
async function findPendingFile(actorId: string, botUserId: string, now: number): Promise<FileRefLike | null> {
  const rows = await db
    .select({ payloadJson: chatMessages.payloadJson, bodyText: chatMessages.bodyText, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(
      and(
        isNull(chatMessages.deletedAt),
        eq(chatMessages.senderUserId, actorId as any),
        eq(chatMessages.recipientUserId, botUserId as any),
        eq(chatMessages.messageType, 'file'),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(5);
  for (const row of rows) {
    const ref = parseFileRef(row.payloadJson);
    if (!ref) continue;
    // Старый запрос не ждёт ответа: иначе любое число в переписке с администратором
    // уводило бы файл, присланный когда-то, кому-то.
    const sentAt = Number(row.createdAt ?? 0) || 0;
    if (sentAt > 0 && now - sentAt > EXCHANGE_BOT_REQUEST_WINDOW_MS) return null;
    return ref;
  }
  return null;
}

/** Отметить отказ в журнале критических событий (оттуда его забирают внешние каналы). */
async function noteFailure(args: {
  title: string;
  humanMessage: string;
  clientId?: string | null;
  username?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await ingestClientCriticalEvent({
      eventCode: EXCHANGE_BOT_EVENT_CODE,
      title: args.title,
      humanMessage: args.humanMessage,
      category: 'other',
      severity: 'warn',
      clientId: args.clientId ?? null,
      username: args.username ?? null,
      aiDetails: args.details ?? {},
      dedupMessage: `${args.clientId ?? ''}|${args.humanMessage.slice(0, 120)}`,
    });
  } catch (e) {
    logWarn('exchange bot: не удалось записать событие', { error: String(e) });
  }
}

/**
 * Правило бота: одно обращение клиента — одно действие.
 *
 * Клиент зовёт бота после того, как оператор отправил сообщение (текст или файл)
 * в переписку с ботом. Сервер решает по содержанию:
 *   * сообщение с файлом → бот спрашивает, кому переслать (или пересылает сразу,
 *     если выбор однозначен);
 *   * ответ номером → бот пересылает файл выбранному;
 *   * всё остальное → бот молчит (это обычное письмо администратору).
 */
export async function runExchangeBotAction(trigger: ExchangeBotTrigger): Promise<ExchangeBotActionResult> {
  const actorId = String(trigger.actor?.id ?? '').trim();
  if (!actorId) return { ok: false, acted: false, error: 'auth required' };

  const botUserId = await getSuperadminUserId();
  if (!botUserId) return { ok: false, acted: false, error: 'в системе нет супер-администратора' };

  // Сообщение адресовано не боту — это обычная переписка, бот молчит.
  if (String(trigger.recipientUserId ?? '').trim() !== botUserId) {
    return { ok: true, acted: false, reason: 'сообщение адресовано не боту' };
  }

  const now = Date.now();
  if (floodBlocked(actorId, now)) {
    return { ok: true, acted: false, reason: 'слишком много обращений к боту — подождите минуту' };
  }

  // Сообщение на сервере может ещё не быть (push идёт асинхронно) — тогда верим
  // тому, что прислал клиент, но проверку отправителя делаем по строке, когда она есть.
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.id, trigger.messageId)).limit(1);
  const row = rows[0] as any;
  if (row) {
    if (String(row.senderUserId ?? '') !== actorId) {
      return { ok: true, acted: false, reason: 'сообщение отправлено не этим оператором' };
    }
    if (String(row.recipientUserId ?? '') !== botUserId) {
      return { ok: true, acted: false, reason: 'сообщение адресовано не боту' };
    }
  }

  const messageType = row ? String(row.messageType ?? 'text') : trigger.fileId ? 'file' : 'text';
  const fileRef = row ? parseFileRef(row.payloadJson) : null;
  const text = String(row?.bodyText ?? trigger.text ?? '').trim();

  const senderLogin = String(trigger.actor?.username ?? '').trim();
  const { candidates, currentMachine } = await resolveExchangeBotMachines({
    senderLogin,
    currentClientId: trigger.clientId ?? null,
    currentClientName: trigger.clientName ?? null,
    currentDeviceKind: trigger.deviceKind ?? null,
    now,
  });

  // ── Запрос: оператор прислал файл ────────────────────────────────────────────
  if (messageType === 'file') {
    const fileId = String(trigger.fileId ?? fileRef?.id ?? '').trim();
    const fileName =
      String(trigger.fileName ?? fileRef?.name ?? '').trim() || (fileId ? await fileNameById(fileId) : '') || 'файл';
    if (!fileId) {
      const reply = 'Бот обмена: не понял, что переслать — пришлите файл ещё раз.';
      await replyAsBot(actorId, reply);
      return { ok: true, acted: true, reply };
    }

    if (candidates.length === 0) {
      const reply =
        'Бот обмена: не нашёл, куда переслать — нет ни одной машины, где кто-то авторизован. Скажите администратору.';
      await replyAsBot(actorId, reply);
      await noteFailure({
        title: 'Бот обмена не нашёл машину-получателя',
        humanMessage: reply,
        clientId: trigger.clientId ?? null,
        username: senderLogin,
        details: { fileId, clientId: trigger.clientId ?? null },
      });
      return { ok: true, acted: true, reply };
    }

    // Выбор однозначный — спрашивать нечего, отправляем сразу.
    if (candidates.length === 1) {
      const candidate = candidates[0]!;
      const sent = await forwardFileToCandidate({ actor: trigger.actor, fileId, candidate, senderName: senderLogin });
      if (!sent.ok) {
        const reply = `Бот обмена: не смог переслать файл «${fileName}» — ${sent.error}.`;
        await replyAsBot(actorId, reply);
        await noteFailure({
          title: 'Бот обмена не смог переслать файл',
          humanMessage: reply,
          clientId: trigger.clientId ?? null,
          username: senderLogin,
          details: { fileId, error: sent.error },
        });
        return { ok: true, acted: true, reply, error: sent.error };
      }
      const reply = buildExchangeBotSentText({
        fileName,
        recipientName: candidate.userName ?? candidate.login ?? 'получателю',
        machineName: candidate.machineName,
        deviceKind: candidate.deviceKind,
        senderName: senderLogin,
      });
      await replyAsBot(actorId, reply);
      logInfo('exchange bot: файл переслан', {
        clientId: trigger.clientId ?? null,
        fileId,
        recipient: candidate.clientId,
        actor: senderLogin,
      });
      return { ok: true, acted: true, reply };
    }

    // Выбора несколько — спрашиваем и предлагаем список.
    const reply = buildExchangeBotQuestion({
      senderName: senderLogin,
      currentMachine,
      candidates,
      fileName,
    });
    await replyAsBot(actorId, reply);
    return { ok: true, acted: true, reply };
  }

  // ── Ответ оператора: номер из списка ─────────────────────────────────────────
  const choice = parseExchangeBotChoice(text);
  if (choice == null) return { ok: true, acted: false, reason: 'не ответ на вопрос бота' };

  // Подсказка клиента (файл ещё мог не уехать на сервер) — но только если он свежий:
  // файл ждёт ответа десять минут, потом не ждёт.
  const hintSentAt = Number(trigger.pendingFileSentAt ?? 0) || 0;
  const hintFresh =
    Boolean(trigger.pendingFileId) && hintSentAt > 0 && now - hintSentAt <= EXCHANGE_BOT_REQUEST_WINDOW_MS;
  const pending =
    (await findPendingFile(actorId, botUserId, now)) ??
    (hintFresh ? { id: String(trigger.pendingFileId), name: '' } : null);
  if (!pending?.id) {
    const reply = 'Бот обмена: не вижу файла, который вы прислали — пришлите его ещё раз.';
    await replyAsBot(actorId, reply);
    return { ok: true, acted: true, reply };
  }

  const candidate = pickExchangeBotCandidate(candidates, choice);
  if (!candidate) {
    const reply = `Бот обмена: нет получателя под номером ${choice}. Список — в моём предыдущем сообщении.`;
    await replyAsBot(actorId, reply);
    return { ok: true, acted: true, reply };
  }

  const sent = await forwardFileToCandidate({
    actor: trigger.actor,
    fileId: pending.id,
    candidate,
    senderName: senderLogin,
  });
  if (!sent.ok) {
    const failedName = sent.ok ? '' : pending.name || (await fileNameById(pending.id)) || 'файл';
    const reply = `Бот обмена: не смог переслать файл «${failedName}» — ${sent.error}.`;
    await replyAsBot(actorId, reply);
    await noteFailure({
      title: 'Бот обмена не смог переслать файл',
      humanMessage: reply,
      clientId: trigger.clientId ?? null,
      username: senderLogin,
      details: { fileId: pending.id, error: sent.error },
    });
    return { ok: true, acted: true, reply, error: sent.error };
  }

  const reply = buildExchangeBotSentText({
    fileName: sent.fileName,
    recipientName: candidate.userName ?? candidate.login ?? 'получателю',
    machineName: candidate.machineName,
    deviceKind: candidate.deviceKind,
    senderName: senderLogin,
  });
  await replyAsBot(actorId, reply);
  logInfo('exchange bot: файл переслан по выбору', {
    clientId: trigger.clientId ?? null,
    fileId: pending.id,
    recipient: candidate.clientId,
    actor: senderLogin,
  });
  return { ok: true, acted: true, reply };
}

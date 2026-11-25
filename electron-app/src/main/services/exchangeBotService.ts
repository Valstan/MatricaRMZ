/**
 * Бот обмена и пересылки — клиентская половина.
 *
 * Клиент зовёт бота после того, как оператор отправил сообщение (текст или файл)
 * в переписку с ботом. Что именно делать — решает сервер (`/exchange-bot/act`):
 * он знает реестр машин парка, умеет переслать файл личным сообщением чата и
 * отвечает от имени бота.
 *
 * Почему вызов идёт от клиента, а не от сервера по push'у: «где находится
 * отправитель» — это факт о МАШИНЕ, от имени которой он пишет, и она знает его
 * точно (свой clientId, имя хоста и тип устройства). На сервере та же машина
 * видна только по heartbeat'у, а heartbeat отстаёт. Побочный плюс: правило бота
 * не трогает конвейер синхронизации (ни журнала, ни контракта таблиц).
 *
 * Обратная связь оператору не нужна: бот отвечает в той же переписке, и ответ
 * приезжает обычным сообщением чата.
 */
import { hostname } from 'node:os';
import { app } from 'electron';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { ExchangeDeviceKind } from '@matricarmz/shared';

import { httpAuthed } from './httpClient.js';
import { SettingsKey, settingsGetString } from './settingsStore.js';

export type ExchangeBotNotifyInput = {
  /** id отправленного сообщения. */
  messageId: string;
  /** Кому отправлено (id пользователя). */
  recipientUserId: string | null;
  /** Файл, если сообщение с файлом. */
  fileId?: string | null;
  /** Имя файла. */
  fileName?: string | null;
  /** Текст сообщения (если это не файл). */
  text?: string | null;
};

export type ExchangeBotNotifyResult = {
  ok: boolean;
  /** Бот что-то сделал. */
  acted?: boolean;
  /** Текст ответа бота (если отвечал). */
  reply?: string | null;
  /** Почему бот промолчал. */
  reason?: string | null;
  error?: string;
};

/**
 * Последний файл, отправленный боту: подсказка для ответа номером.
 *
 * Ответ приходит следующим сообщением, а сообщение с файлом к серверу могло ещё
 * не уехать (push асинхронный). Без подсказки бот сказал бы «не вижу файла» —
 * то есть отказал бы на ровном месте.
 */
let lastBotFileId: string | null = null;

/** Запомнить файл, отправленный боту. */
export function rememberExchangeBotFile(fileId: string | null | undefined): void {
  const id = String(fileId ?? '').trim();
  if (id) lastBotFileId = id;
}

/** Тип машины по платформе клиента. На android — планшет (APK ставится на планшет). */
export function detectExchangeDeviceKind(): ExchangeDeviceKind {
  const p = String(globalThis.process?.platform ?? '').trim().toLowerCase();
  if (p === 'win32' || p === 'darwin' || p === 'linux') return 'computer';
  if (p === 'android' || p === 'ios') return 'tablet';
  return 'other';
}

/**
 * Позвать бота. Ошибка НЕ ломает отправку сообщения: письмо оператора уже ушло,
 * а бот — улучшение, а не условие переписки.
 */
export async function notifyExchangeBot(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: ExchangeBotNotifyInput,
): Promise<ExchangeBotNotifyResult> {
  const messageId = String(args.messageId ?? '').trim();
  const recipientUserId = String(args.recipientUserId ?? '').trim();
  if (!messageId || !recipientUserId) return { ok: false, error: 'нечего звать' };

  const fileId = String(args.fileId ?? '').trim();
  if (fileId) rememberExchangeBotFile(fileId);

  const clientId = String((await settingsGetString(db, SettingsKey.ClientId).catch(() => null)) ?? '').trim();
  try {
    const r = await httpAuthed(
      db,
      apiBaseUrl,
      '/exchange-bot/act',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          recipientUserId,
          clientId: clientId || null,
          clientName: hostname(),
          deviceKind: detectExchangeDeviceKind(),
          appVersion: app.getVersion(),
          fileId: fileId || null,
          fileName: args.fileName ?? null,
          pendingFileId: lastBotFileId,
          text: args.text ?? null,
        }),
      },
      { timeoutMs: 20_000 },
    );
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok) return { ok: false, error: String(j?.error ?? 'плохой ответ сервера') };
    return {
      ok: true,
      acted: j.acted === true,
      reply: j.reply == null ? null : String(j.reply),
      reason: j.reason == null ? null : String(j.reason),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

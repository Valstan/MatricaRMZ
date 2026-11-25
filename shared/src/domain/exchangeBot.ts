/**
 * Бот обмена и пересылки — домен.
 *
 * Бот принимает от оператора файл (или сообщение), спрашивает, кому его переслать,
 * и отправляет через существующий транспорт — личное сообщение чата с файлом.
 * Своей таблицы нет намеренно (см. `docs/CODEBASE_MAP.md`, строка «Передача файлов
 * между Верстаками»): такое сообщение уже синхронизируется получателю и уже выдаёт
 * ему доступ к файлу.
 *
 * Здесь — только чистая логика: как называть машину, как собрать вопрос бота и как
 * разобрать ответ оператора. Всё, что ходит в базу и в сеть, — на сервере
 * (`backend-api/src/services/exchangeBotService.ts`).
 */

/** Имя бота в переписке. Учётная запись — у супер-администратора (как у бота тревог). */
export const EXCHANGE_BOT_USERNAME = 'Бот обмена';

/** Код события в журнале критических событий (только отказы — успех не «критический»). */
export const EXCHANGE_BOT_EVENT_CODE = 'exchange.bot.forward';

/** Сколько машин показываем в списке получателей: больше — шум, а не выбор. */
export const EXCHANGE_BOT_MAX_CANDIDATES = 10;

/**
 * Сколько дней машина считается «живой» (в списке получателей).
 *
 * Парк планшетов почти весь отвалился с августа (см. handoff): такие машины в
 * списке только мешают — выбрать их нельзя, они не примут файл.
 */
export const EXCHANGE_BOT_MACHINE_ALIVE_WINDOW_DAYS = 14;

/**
 * Сколько живёт «ожидающий ответа» файл.
 *
 * Оператор отвечает на вопрос сразу. Файл, присланный боту час назад, ответом
 * «2» уже не пересылается: иначе любое число в переписке с администратором
 * уводило бы старый файл кому-то.
 */
export const EXCHANGE_BOT_REQUEST_WINDOW_MS = 10 * 60_000;

/** Тип машины. Определяет, как бот её называет: «вы на планшете …». */
export type ExchangeDeviceKind = 'computer' | 'tablet' | 'phone' | 'other';

/** Привести строку клиента (`computer`/`tablet`/`phone`) к типу машины. */
export function exchangeDeviceKind(raw: string | null | undefined): ExchangeDeviceKind {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'computer' || v === 'desktop') return 'computer';
  if (v === 'tablet') return 'tablet';
  if (v === 'phone' || v === 'mobile') return 'phone';
  return 'other';
}

/** Слово для названия машины в тексте бота. */
export function exchangeDeviceWord(kind: ExchangeDeviceKind): string {
  switch (kind) {
    case 'computer':
      return 'компьютер';
    case 'tablet':
      return 'планшет';
    case 'phone':
      return 'телефон';
    default:
      return 'устройство';
  }
}

/** Машина-получатель в списке бота. */
export type ExchangeMachineCandidate = {
  /** Идентификатор клиента (машины) — `client_settings.client_id`. */
  clientId: string;
  /** Имя машины (hostname). */
  machineName: string;
  deviceKind: ExchangeDeviceKind;
  /** Логин, авторизованный на машине (`client_settings.last_username`). */
  login: string | null;
  /** ФИО этого человека (если логин известен серверу). */
  userName: string | null;
  /** Идентификатор пользователя — получателя пересылки. */
  userId: string | null;
  /** Машина, с которой пишет отправитель (её в список не предлагаем). */
  isCurrent: boolean;
  /** На этой машине авторизован сам отправитель. */
  isOwn: boolean;
  /** Когда машина последний раз выходила на связь (unix-мс). */
  lastSeenAt: number | null;
};

/** Где сейчас отправитель. */
export type ExchangeSenderMachine = {
  machineName: string;
  deviceKind: ExchangeDeviceKind;
  clientId?: string | null;
};

/**
 * Разобрать ответ оператора: номер из списка.
 *
 * Только голое число (возможно, с точкой/пробелами) — иначе это обычное сообщение
 * администратору, а не ответ боту.
 */
export function parseExchangeBotChoice(text: string | null | undefined): number | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/**
 * Отмена ответа: оператор пишет «0».
 *
 * Отмена — не «не число»: на неё бот отвечает коротко («отменено»), иначе
 * обещанное в вопросе «(0 — отмена)» осталось бы без ответа.
 */
export function isExchangeBotCancel(text: string | null | undefined): boolean {
  return String(text ?? '').trim() === '0';
}

/** Взять получателя по номеру из списка. */
export function pickExchangeBotCandidate<T extends ExchangeMachineCandidate>(
  candidates: readonly T[],
  choice: number | null,
): T | null {
  if (!choice || choice < 1) return null;
  const found = candidates[choice - 1];
  return found ?? null;
}

/**
 * Текст вопроса бота.
 *
 * Порядок строк — как в ответе владельца («вы на телефоне Макса — отправить на
 * компьютер Совиных?»): сначала где находится отправитель, затем кому отправляем.
 */
export function buildExchangeBotQuestion(input: {
  /** Имя отправителя (ФИО или логин) — бот здоровается по имени. */
  senderName?: string | null;
  currentMachine?: ExchangeSenderMachine | null;
  candidates: readonly ExchangeMachineCandidate[];
  /** Имя файла, который пересылают (если пересылают файл). */
  fileName?: string | null;
}): string {
  const lines: string[] = [];
  const where = input.currentMachine
    ? `вы на ${exchangeDeviceWord(input.currentMachine.deviceKind)} ${input.currentMachine.machineName}`.trim()
    : 'вы на неизвестной машине';
  const file = String(input.fileName ?? '').trim();
  const what = file ? `Файл «${file}».` : '';
  lines.push(`Бот обмена: ${where}.${what ? ` ${what}` : ''}`);

  if (input.candidates.length === 0) {
    lines.push('Кому отправить — не нашёл: нет ни одной машины, где кто-то авторизован. Скажите администратору.');
    return lines.join('\n');
  }

  lines.push('Кому отправить?');
  input.candidates.forEach((c, i) => {
    const parts: string[] = [];
    parts.push(`${exchangeDeviceWord(c.deviceKind)} ${c.machineName}`.trim());
    if (c.userName) parts.push(c.userName);
    if (c.isOwn) parts.push('(вы)');
    lines.push(`${i + 1}) ${parts.join(' — ')}`);
  });
  lines.push('Ответьте номером (0 — отмена).');
  return lines.join('\n');
}

/** Текст подтверждения отправки. */
export function buildExchangeBotSentText(input: {
  fileName?: string | null;
  recipientName: string;
  machineName: string;
  deviceKind: ExchangeDeviceKind;
  senderName?: string | null;
}): string {
  const file = String(input.fileName ?? '').trim();
  const from = String(input.senderName ?? '').trim();
  const prefix = from ? `Файл «${file}» от ${from} переслан ` : `Файл «${file}» переслан `;
  return `${prefix}${input.recipientName} — на ${exchangeDeviceWord(input.deviceKind)} ${input.machineName}. Ответчик увидит приглашение принять файл.`;
}

/**
 * Порядок машин в списке: сначала машины самого отправителя (по умолчанию — «ваш
 * компьютер»), потом чужие. Внутри — по свежести связи: живая машина выше.
 */
export function sortExchangeBotCandidates<T extends ExchangeMachineCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
    const at = Number(a.lastSeenAt ?? 0) || 0;
    const bt = Number(b.lastSeenAt ?? 0) || 0;
    if (at !== bt) return bt - at;
    return a.machineName.localeCompare(b.machineName, 'ru');
  });
}

/**
 * Текст неудачи для оператора — одно правило на весь клиент.
 *
 * Инцидент 23.11.2026 (жалоба оператора парка, жалоба в чат владельцу): кнопка
 * «сообщить администратору» в баннере застрявшей очереди вернула
 * «Не отправилось: <170 КБ страницы Kaspersky>». Тело ответа от чужого сервера
 * (страница антивируса, страница прокси, HTML-ошибка nginx) оператору целиком
 * не годится: оно не читается, а копируется в чат и тащит туда чужую разметку.
 *
 * Правило одно на программу:
 *  - JSON-ошибка от нашего сервера — показываем как есть (там написано, что не так);
 *  - страница вместо ответа — страницу НЕ показываем, а называем причину: обычно
 *    соединение перехватил антивирус или прокси (на парке это Kaspersky);
 *  - прочий текст — режем до читаемого размера.
 *
 * Где правило применяется: все места, где тело ответа сервера попадает в текст,
 * который видит оператор (IPC-регистраторы, отчёт о застрявшей очереди, ошибки
 * модулей). Логи синка — другое дело: там тело ответа нужно целиком, это
 * материал для разбора администратором (`syncService.ts`, `safeBodyText`).
 */

/** Максимум символов обычного текста ошибки в сообщении оператору. */
const MAX_ERROR_TEXT = 300;

/** Что пришло в ответ: причина (текст) и признак «это веб-страница». */
type FailureReason = { text: string; isPage: boolean };

/**
 * Похоже на веб-страницу, а не на ответ нашего сервера?
 *
 * Признаки: doctype/html в начале, а также «<head>»/«<body>» в первых символах —
 * наш сервер отвечает JSON (или коротким текстом), страница приходит от антивируса,
 * прокси или nginx-а с чужой страницы ошибок.
 */
export function looksLikeHtmlPage(text: string): boolean {
  const head = String(text ?? '')
    .trim()
    .slice(0, 400)
    .toLowerCase();
  if (!head) return false;
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.includes('<head>') ||
    head.includes('<head ') ||
    head.includes('<body')
  );
}

/** Одной строкой и без обрезки посередине слова — читаемый текст ошибки. */
function clip(text: string): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= MAX_ERROR_TEXT) return flat;
  return `${flat.slice(0, MAX_ERROR_TEXT).trimEnd()}…`;
}

/** Причина неудачи: ошибка нашего сервера, страница чужого сервера или прочий текст. */
function failureReason(res: { status?: number; json?: unknown; text?: unknown }): FailureReason {
  const jsonObj = res?.json && typeof res.json === 'object' ? (res.json as Record<string, unknown>) : null;
  const jsonErr = jsonObj ? (jsonObj.error ?? jsonObj.message ?? null) : null;
  const raw =
    typeof jsonErr === 'string'
      ? jsonErr
      : jsonErr != null
        ? JSON.stringify(jsonErr)
        : typeof res?.text === 'string'
          ? res.text.trim()
          : '';
  if (!raw) return { text: '', isPage: false };
  if (looksLikeHtmlPage(raw)) {
    return {
      text: 'вместо ответа сервера пришла веб-страница (обычно соединение перехватил антивирус или прокси) — страницу не показываем, нужна причина',
      isPage: true,
    };
  }
  return { text: clip(raw), isPage: false };
}

/**
 * Текст неудачи для оператора — причина без статуса.
 *
 * Так его видят IPC-регистраторы: их ошибка и есть причина, а статус HTTP
 * оператору ничего не добавляет.
 */
export function httpFailureText(res: { status?: number; json?: unknown; text?: unknown }): string {
  const reason = failureReason(res);
  if (!reason.text) return `HTTP ${Number(res?.status ?? 0)}`;
  return reason.text;
}

/**
 * Текст неудачи со статусом — «HTTP 502: причина».
 *
 * Так его видят модули, где статус полезен (бэкапы, права, изменения): сначала
 * код ответа, потом короткая причина.
 */
export function httpFailureLine(res: { status?: number; json?: unknown; text?: unknown }): string {
  const status = Number(res?.status ?? 0);
  const reason = failureReason(res);
  if (!reason.text) return `HTTP ${status}`;
  return `HTTP ${status}: ${reason.text}`;
}

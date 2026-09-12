/**
 * Человеческие сообщения об отказе входа (владелец 12.09.2026: «если пароль неправильный, надо
 * чтобы модалка появлялась с этим сообщением, а то сейчас просто код ошибки выпадает»).
 *
 * До этого клиент показывал сырую строку транспорта — `login HTTP 401: {"ok":false,...}`. Разбор
 * живёт здесь, а не в экране: он нужен и при входе, и при регистрации, и его надо проверять тестом
 * без Electron. Сервер уже отвечает по-русски, но внутри JSON-тела — вытаскиваем его текст, а если
 * тела нет, говорим сами.
 */
export type AuthFailureCode =
  | 'invalid_credentials'
  | 'no_access'
  | 'login_taken'
  | 'reserved_login'
  | 'bad_request'
  | 'server'
  | 'offline'
  | 'unknown';

export type AuthFailure = {
  code: AuthFailureCode;
  /** Готовая строка для оператора: что случилось и что делать. */
  message: string;
};

/** Коды, при которых оператору показывают модалку, а не строчку под формой. */
export function authFailureNeedsModal(code: AuthFailureCode): boolean {
  return code === 'invalid_credentials' || code === 'no_access' || code === 'offline';
}

function serverText(rawBody: string): string {
  const body = String(rawBody ?? '').trim();
  if (!body) return '';
  try {
    const json = JSON.parse(body) as unknown;
    if (json && typeof json === 'object') {
      const error = (json as Record<string, unknown>).error;
      // Zod-ошибки приходят объектом `flatten()` — оператору он бесполезен.
      if (typeof error === 'string') return error.trim();
    }
  } catch {
    // Не JSON — пусть в сообщение не попадает сырой HTML/текст ошибки прокси.
  }
  return '';
}

function capitalize(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Разбирает неуспешный ответ `/auth/login` или `/auth/register`.
 * `status` — HTTP-код, `rawBody` — тело как есть.
 */
export function describeAuthFailure(args: { status: number; rawBody?: string }): AuthFailure {
  const status = Number(args.status ?? 0);
  const text = serverText(args.rawBody ?? '');

  if (status === 401) {
    return { code: 'invalid_credentials', message: 'Неверный логин или пароль. Проверьте раскладку клавиатуры и Caps Lock.' };
  }
  if (status === 403) {
    // Два разных 403: у сотрудника нет доступа в программу и зарезервированный логин.
    if (text.includes('зарезервирован')) return { code: 'reserved_login', message: capitalize(text) };
    return {
      code: 'no_access',
      message: text ? capitalize(text) : 'Доступ в программу для этого сотрудника закрыт. Обратитесь к администратору.',
    };
  }
  if (status === 409) {
    return { code: 'login_taken', message: text ? capitalize(text) : 'Такой логин уже занят.' };
  }
  if (status === 400) {
    return { code: 'bad_request', message: 'Заполнены не все поля или данные введены неверно.' };
  }
  if (status >= 500) {
    return { code: 'server', message: 'Сервер не смог обработать вход. Попробуйте ещё раз или сообщите администратору.' };
  }
  return { code: 'unknown', message: text ? capitalize(text) : `Вход не выполнен (код ${status || 'неизвестен'}).` };
}

/** Отказ на уровне сети: до сервера не дошли вовсе. */
export function describeAuthNetworkFailure(_raw: unknown): AuthFailure {
  return { code: 'offline', message: 'Нет связи с сервером. Проверьте сеть и попробуйте ещё раз.' };
}

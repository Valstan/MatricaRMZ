// Служебные авторы записей: логины, которыми программа и разовые скрипты подписывают
// строки `operations` (и других журналов). Оператор видит их в колонке «Кто» и должен
// понимать, что запись сделала программа, а не человек.
//
// Почему словарь, а не переименование скриптов: подписи лежат в журнале навсегда.
// Переименовать актора скрипта можно только для будущих записей, а на проде уже есть
// строки со `stages:backfill` — их по-прежнему надо как-то называть. Словарь покрывает и
// старые, и новые; логины скриптов при этом остаются машинными и в базе не меняются.

/**
 * Логин → что им означает по-русски. Ключи ровно те, что пишут скрипты и main-процесс
 * (`grep "username: '" backend-api/src/scripts`), плюс служебные значения клиента.
 */
const SERVICE_ACTOR_LABELS: Readonly<Record<string, string>> = {
  // Клиент без входа в сеть пишет `local` — человека за машиной нет, и подпись это врёт.
  local: 'эта машина',
  server: 'программа',
  system: 'программа',
  // Перенос прежних отметок в строки единого списка этапов (steps unified-repair-stages).
  'stages:backfill': 'перенос этапов из прежних отметок (программа)',
  'stages:review-order': 'проверка порядка этапов (программа)',
  // Служебные правки ведомости деталей: строки листа, дефектные даты, слияние дублей.
  'engine-inventory:fix-defect-stage-dates': 'исправление дат этапов (программа)',
  'engine-inventory:dedup-sheets': 'слияние дублей ведомости деталей (программа)',
  'engine-inventory:backfill-lines': 'пересчёт строк ведомости деталей (программа)',
  'engine-inventory:strip-rows': 'очистка ведомости деталей (программа)',
  // Стенд и витрина: на боевом парке не встречаются, но в демо-данных остаются.
  'verify-bootstrap': 'стенд (программа)',
  'verify-seed': 'стенд (программа)',
  'demo-seed': 'демо-данные (программа)',
  'merge-check': 'проверка слияния сотрудников (программа)',
  dedupe: 'слияние дублей (программа)',
  superadmin: 'суперадмин',
};

/** Логины, для которых подпись автора не показывается вовсе (знать нечего). */
const BLANK_SERVICE_ACTORS: ReadonlySet<string> = new Set(['local']);

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Подпись автора записи по-русски.
 *
 * Пустая строка — значит «показывать нечего»: неизвестный служебный логин остаётся
 * логином (иначе потерялась бы улика, кто записал), но `local` скрывается, потому что
 * это не автор, а отсутствие автора. Настоящие логины возвращаются как есть — их
 * разворачивают в ФИО на экране отдельным резолвером.
 */
export function serviceActorLabel(value: unknown): string {
  const login = text(value);
  if (!login) return '';
  if (BLANK_SERVICE_ACTORS.has(login)) return '';
  // hasOwnProperty, а не `[login] ?? login`: логин `constructor` или `toString` иначе
  // получил бы в ответ функцию из прототипа и напечатал бы её вместо логина.
  return Object.prototype.hasOwnProperty.call(SERVICE_ACTOR_LABELS, login) ? (SERVICE_ACTOR_LABELS[login] ?? login) : login;
}

/** Служебный ли логин: подпись стоит показать по-русски, а не как логин. */
export function isServiceActor(value: unknown): boolean {
  const login = text(value);
  return login !== '' && Object.prototype.hasOwnProperty.call(SERVICE_ACTOR_LABELS, login);
}
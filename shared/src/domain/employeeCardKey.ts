// Ключ личности сотрудника — правило «один человек = одна карточка».
//
// ПРОБЛЕМА, КОТОРУЮ ЭТОТ МОДУЛЬ РЕШАЕТ. Проверка дубля по ФИО и по табельному номеру
// работала по одному атрибуту: ФИО пишется первым, табельный и даты — позже. Проверить
// по полному ключу «ФИО + табельный номер + должность + дата приёма + ДР» по одному
// атрибуту физически нечем: половины ключа ещё нет. Поэтому нужен ключ как ЕДИНЫЙ
// объект, который сравнивается целиком.
//
// ГДЕ ЖИВЁТ ПРАВИЛО. Здесь, в `shared`, — потому что его считают ДВЕ половины:
// сервер сравнивает ключ приходящей карточки со срезом живых сотрудников, а клиент
// по тому же правилу решает, блокировать запись или предупредить. Разойдутся
// половины — гейт станет разным на сервере и на парке (прецедент
// `contractInternalNumberKey` — общий нормализатор, иначе половины гейта разойдутся
// в понимании «это один и тот же номер»).
//
// ПУСТОЕ ПОЛЕ НЕ РАСХОЖДЕНИЕ. Поле, не заполненное с одной из сторон, просто не
// сравнивается: «не заполнено» — не «по-разному». Иначе гейт рубил бы заведение
// карточки, в которой половина полей ещё пуста (обычное дело для быстрой карточки).
//
// ШКАЛА ГЕЙТА ЗАПИСИ. Отношение карточек упорядочено по силе:
//   'different'  (0) — разные люди: ФИО разошлось (или совпадать не с чем — ФИО пусто)
//   'disputed'   (1) — человек один, а значения разошлись (разные даты, должность или
//                        табельный): предупреждение, решает оператор
//   'exact'      (2) — совпал ключ (ФИО + должность + дата приёма/ДР): запрет с обоснованием
//   'personnel'  (3) — совпал табельный номер: номер идентифицирует человека, запрет
//                        без обоснования
// Это шкала ГЕЙТА ЗАПИСИ, а не шкала СЛИЯНИЯ: слияние (`employeeRelation` в
// `employeeDedupeService`) отвечает на другой вопрос — можно ли слить две карточки —
// и живёт по своим правилам. Порядок важен и для сравнения «стало ли хуже после этой
// записи»: гейт блокирует только НОВУЮ связь (см. `isNewRelation`) — иначе нельзя было
// бы ни поправить, ни слить дубль, который был до нас.

/** Коды атрибутов, из которых собирается ключ личности. */
export const EMPLOYEE_CARD_KEY_CODES = [
  'full_name',
  'personnel_number',
  'role',
  'hire_date',
  'birth_date',
] as const;

export type EmployeeCardKeyCode = (typeof EMPLOYEE_CARD_KEY_CODES)[number];

/** Нормализованный ключ: пустая строка означает «не заполнено». */
export type EmployeeCardKey = {
  fullName: string;
  personnelNumber: string;
  position: string;
  /** 'YYYY-MM-DD' либо пустая строка. */
  hireDate: string;
  /** 'YYYY-MM-DD' либо пустая строка. */
  birthDate: string;
};

export type EmployeeCardRelation = 'different' | 'disputed' | 'exact' | 'personnel';

export type EmployeeCardComparison = {
  relation: EmployeeCardRelation;
  /** Какие поля ключа совпали. */
  matchedBy: string[];
  /** Какие поля ключа расходятся (заполнены с обеих сторон и различаются). */
  conflicts: string[];
};

/** Сила связи: чем выше, тем жёстче гейт. */
const RELATION_LEVEL: Record<EmployeeCardRelation, number> = {
  different: 0,
  disputed: 1,
  exact: 2,
  personnel: 3,
};

export function employeeCardRelationLevel(relation: EmployeeCardRelation): number {
  return RELATION_LEVEL[relation];
}

/**
 * Календарный день по московскому времени.
 *
 * ПОЧЕМУ НЕ ФИКСИРОВАННОЕ СМЕЩЕНИЕ. Один и тот же день разные писатели отдают
 * разными миллисекундами: клиент пишет локальную полночь машины (Europe/Moscow),
 * серверный импорт — полночь по UTC. Фиксированное смещение +03:00 сводило их к
 * одному дню, но ТОЛЬКО для дат после 2014 года: до 2014-го в Москве было декретное
 * время (UTC+4 летом), и день рождения 1985 года съезжал на сутки назад — ключ
 * переставал совпадать сам с собой, а дубли по ПДО проходили мимо гейта. Поэтому
 * календарный день считается в зоне Europe/Moscow: и полночь по Москве, и полночь по
 * UTC попадают в один и тот же московский день — и для 1985 года, и для 2026-го.
 */
const MSK_TIME_ZONE = 'Europe/Moscow';

const mskDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MSK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function dateKeyFromEpochMs(ms: number): string {
  const parts = mskDateFormatter.formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Значение даты → 'YYYY-MM-DD'. Принимает epoch-мс (числом или строкой), 'ГГГГ-ММ-ДД',
 * 'ДД.ММ.ГГГГ' и ISO-строку. Неразобранное — пустая строка (значение не заполнено).
 */
export function normalizeEmployeeDate(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return '';
    return dateKeyFromEpochMs(raw);
  }
  const text = String(raw).trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return dateKeyFromEpochMs(Number(text));
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return dateKeyFromEpochMs(parsed);
  return '';
}

/** ФИО: регистр, «ё» и лишние пробелы не должны плодить дубли. */
export function normalizeEmployeeFullName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/** Табельный номер: «00675» и «675» — один человек (тот же ключ, что у номера РМЗ). */
export function normalizeEmployeePersonnelNumber(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return String(Number(text));
  return text.toLowerCase();
}

/** Должность: «Водитель  погрузчика» и «водитель погрузчика» — одна должность. */
export function normalizeEmployeePosition(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/** Собирает ключ из значений атрибутов карточки. Неизвестные коды игнорируются. */
export function employeeCardKeyFromFields(fields: Record<string, unknown>): EmployeeCardKey {
  return {
    fullName: normalizeEmployeeFullName(fields['full_name']),
    personnelNumber: normalizeEmployeePersonnelNumber(fields['personnel_number']),
    position: normalizeEmployeePosition(fields['role']),
    hireDate: normalizeEmployeeDate(fields['hire_date']),
    birthDate: normalizeEmployeeDate(fields['birth_date']),
  };
}

/**
 * Отношение двух карточек — по правилу ГЕЙТА ЗАПИСИ.
 *
 * Порядок решений:
 *  1. табельный номер равный у обеих — человек один (номер идентифицирует человека),
 *     даже если ФИО в одной из карточек отличается (опечатка в имени);
 *  2. ФИО разошлось (или не заполнено — сравнивать не с чем) — разные люди;
 *  3. ФИО совпало, но разошлись должность, дата приёма, ДР или табельный — человек один,
 *     а значения разошлись: спорный случай, решает оператор;
 *  4. ФИО совпало и совпали ещё ДВА из трёх «сильных» полей (должность, дата приёма, ДР)
 *     — совпал ключ;
 *  5. ФИО совпало и сильных полей не хватило — однофамильцы, предупреждение.
 */
export function compareEmployeeCardKeys(
  a: EmployeeCardKey,
  b: EmployeeCardKey,
): EmployeeCardComparison {
  const matchedBy: string[] = [];
  const conflicts: string[] = [];

  if (a.personnelNumber && b.personnelNumber) {
    if (a.personnelNumber === b.personnelNumber) matchedBy.push('personnel_number');
    else conflicts.push('personnel_number');
  }
  if (a.fullName && b.fullName) {
    if (a.fullName === b.fullName) matchedBy.push('full_name');
    else conflicts.push('full_name');
  }
  if (a.position && b.position) {
    if (a.position === b.position) matchedBy.push('role');
    else conflicts.push('role');
  }
  if (a.hireDate && b.hireDate) {
    if (a.hireDate === b.hireDate) matchedBy.push('hire_date');
    else conflicts.push('hire_date');
  }
  if (a.birthDate && b.birthDate) {
    if (a.birthDate === b.birthDate) matchedBy.push('birth_date');
    else conflicts.push('birth_date');
  }

  // Номер идентифицирует человека — даже если имя в одной из карточек отличается.
  if (matchedBy.includes('personnel_number')) {
    return { relation: 'personnel', matchedBy, conflicts };
  }
  // Без совпавшего ФИО сравнивать нечего, а разные ФИО — это разные люди.
  if (!matchedBy.includes('full_name')) {
    return { relation: 'different', matchedBy, conflicts };
  }
  // Человек один, а значения разошлись: спорный случай, решает оператор.
  if (conflicts.length > 0) {
    return { relation: 'disputed', matchedBy, conflicts };
  }
  // Ключ сошёлся, когда кроме ФИО совпали ещё ДВА из трёх сильных полей: должность,
  // дата приёма на работу, день рождения. Одно сильное поле — ещё не ключ: у однофамильца
  // может совпасть и должность, и дата приёма (приняты в один день), но не ДР.
  const strongMatched = matchedBy.filter((code) => code === 'role' || code === 'hire_date' || code === 'birth_date');
  if (strongMatched.length >= 2) {
    return { relation: 'exact', matchedBy, conflicts };
  }
  // Совпало только ФИО (или ФИО с одним сильным полем) — однофамильцы.
  return { relation: 'disputed', matchedBy, conflicts };
}

/**
 * Гейт блокирует только НОВОЕ совпадение.
 *
 * Дубль, который был до записи, — не вина этой записи: карточка могла прийти из
 * импорта ЗУП, её могли завести на другой машине. Блокировать правку такой карточки
 * нельзя — иначе дубль нельзя ни поправить, ни слить (слияние требует правок карточек).
 * Поэтому сравниваем отношение ДО записи и ПОСЛЕ: блокируем, только если запись
 * сама подняла связь (например, дописала дату приёма, и ключ стал полным).
 *
 * ПОЧЕМУ ПО МНОЖЕСТВУ СОВПАВШИХ ПОЛЕЙ, А НЕ ПО УРОВНЮ СВЯЗИ. Уровень связи груб:
 * карточка «ФИО + должность + дата приёма» и карточка «ФИО + должность + дата приёма
 * + ДР» — обе дают один уровень, и дописывание ПОСЛЕДНЕГО поля ключа не было бы
 * заметно. Именно этот случай и есть главный: приходит ПДО с датами приёма и ДР, и
 * ключ дописывается на глазах у оператора. Поэтому «новая связь» — это РОСТ множества
 * совпавших полей ключа, а не рост уровня.
 */
export function isNewEmployeeCardRelation(
  before: EmployeeCardComparison,
  after: EmployeeCardComparison,
): boolean {
  // Табельный номер — особый случай: он идентифицирует человека сам по себе.
  if (after.relation === 'personnel' && before.relation !== 'personnel') return true;
  const beforeMatched = new Set(before.matchedBy);
  const gained = after.matchedBy.filter((code) => !beforeMatched.has(code));
  if (gained.length === 0) return false;
  // Совпадений прибавилось — связь стала крепче. Но если ФИО не совпало, сравнивать
  // нечего: разные люди.
  return after.relation !== 'different';
}

/**
 * Гейт блокирует только НОВОЕ совпадение — по уровню связи.
 *
 * Грубая проверка уровня: подходит там, где важен сам уровень (жёсткий запрет против
 * предупреждения). Для «новая связь» используйте `isNewEmployeeCardRelation` — она
 * ловит дописывание последнего поля ключа, чего уровень не видит.
 */
export function isNewRelation(before: EmployeeCardRelation, after: EmployeeCardRelation): boolean {
  return RELATION_LEVEL[after] > RELATION_LEVEL[before];
}

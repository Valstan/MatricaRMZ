const RU_LOCALE = 'ru-RU';
const MOSCOW_TIME_ZONE = 'Europe/Moscow';

function toDate(value: number | Date) {
  return value instanceof Date ? value : new Date(value);
}

function toFiniteNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export function formatMoscowDate(value: number | Date) {
  return toDate(value).toLocaleDateString(RU_LOCALE, { timeZone: MOSCOW_TIME_ZONE });
}

export function formatMoscowDateTime(value: number | Date) {
  return toDate(value).toLocaleString(RU_LOCALE, { timeZone: MOSCOW_TIME_ZONE });
}

// Дата+время без секунд для ячеек списков: «01.06.2026, 10:32». Секунды в списках —
// шум, который раздувал значение до ~20 символов и обрезался узкой колонкой
// («…10:3…»). UI-аудит проход-2 #2.
export function formatListDateTime(value: number | Date) {
  return toDate(value).toLocaleString(RU_LOCALE, {
    timeZone: MOSCOW_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatMoscowTime(value: number | Date) {
  return toDate(value).toLocaleTimeString(RU_LOCALE, {
    timeZone: MOSCOW_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatMoscowLongDateTime(value: number | Date) {
  const date = toDate(value);
  const datePart = new Intl.DateTimeFormat(RU_LOCALE, {
    timeZone: MOSCOW_TIME_ZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
  const timePart = new Intl.DateTimeFormat(RU_LOCALE, {
    timeZone: MOSCOW_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${datePart.replace(/\s*г\.?$/u, '')}, ${timePart}`;
}

// «14 июля» — день + месяц словом, без года (печатные формы: год виден в дате наряда).
export function formatMoscowDayMonthName(value: number | Date) {
  return new Intl.DateTimeFormat(RU_LOCALE, {
    timeZone: MOSCOW_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  }).format(toDate(value));
}

export function formatRuNumber(value: number, options: Intl.NumberFormatOptions = {}) {
  return toFiniteNumber(value).toLocaleString(RU_LOCALE, options);
}

export function formatRuMoney(value: number, options: Intl.NumberFormatOptions = {}) {
  return `${formatRuNumber(value, options)} ₽`;
}

export function formatRuPercent(value: number, options: Intl.NumberFormatOptions = { minimumFractionDigits: 1, maximumFractionDigits: 1 }) {
  return `${formatRuNumber(value, options)}%`;
}

// Ключ московских суток «YYYY-MM-DD» — по нему чат режет ленту на дни. Считать
// день по локальной дате клиента нельзя: у машин в разных поясах разделители
// встали бы в разных местах одной и той же переписки.
export function moscowDayKey(value: number | Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(toDate(value));
  return parts;
}

// Подпись разделителя дня в ленте чата: «Сегодня» / «Вчера» / «15 августа 2026».
export function formatChatDaySeparator(value: number | Date, now: number | Date = Date.now()): string {
  const dayKey = moscowDayKey(value);
  const todayKey = moscowDayKey(now);
  if (dayKey === todayKey) return 'Сегодня';
  const yesterdayKey = moscowDayKey(toDate(now).getTime() - 24 * 60 * 60 * 1000);
  if (dayKey === yesterdayKey) return 'Вчера';
  return new Intl.DateTimeFormat(RU_LOCALE, {
    timeZone: MOSCOW_TIME_ZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
    .format(toDate(value))
    .replace(/\s*г\.?$/u, '');
}

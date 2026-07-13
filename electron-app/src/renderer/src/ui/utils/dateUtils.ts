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

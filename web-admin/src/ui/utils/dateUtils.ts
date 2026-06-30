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

export function formatRuNumber(value: number, options: Intl.NumberFormatOptions = {}) {
  return toFiniteNumber(value).toLocaleString(RU_LOCALE, options);
}

export function formatRuMoney(value: number, options: Intl.NumberFormatOptions = {}) {
  return `${formatRuNumber(value, options)} ₽`;
}

export function formatRuPercent(value: number, options: Intl.NumberFormatOptions = { minimumFractionDigits: 1, maximumFractionDigits: 1 }) {
  return `${formatRuNumber(value, options)}%`;
}

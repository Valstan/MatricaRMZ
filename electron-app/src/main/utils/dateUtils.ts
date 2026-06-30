const RU_LOCALE = 'ru-RU';
const MOSCOW_TIME_ZONE = 'Europe/Moscow';

function toDate(value: number | Date) {
  return value instanceof Date ? value : new Date(value);
}

function toFiniteNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export function formatMoscowDate(value: number | Date | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return toDate(value).toLocaleDateString(RU_LOCALE, { timeZone: MOSCOW_TIME_ZONE });
}

export function formatMoscowDateTime(value: number | Date | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return toDate(value).toLocaleString(RU_LOCALE, { timeZone: MOSCOW_TIME_ZONE });
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

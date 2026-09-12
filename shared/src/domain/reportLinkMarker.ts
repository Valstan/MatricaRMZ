import type { ReportPresetFilters } from './reports.js';

/**
 * Маркер отчёта в ответе ИИваныча: `[report:<id>]` или `[report:<id>?<нагрузка>]`.
 *
 * Нагрузку (готовые настройки отчёта) собирает СЕРВЕР в `suggest_report` и отдаёт модели
 * строкой целиком — модель её только копирует в ответ. Просить модель самой собрать JSON
 * настроек нельзя: она путает ключи фильтров и формат дат, а ошибку видно только оператору,
 * который открыл отчёт с чужим отбором.
 *
 * Кодировка — base64url: в ней нет символов, ломающих разметку ответа (кавычек, скобок,
 * пробелов), поэтому маркер переживает любую вёрстку и не рвётся на переносе строки.
 */
export type ReportLinkPayload = {
  /** Значения фильтров пресета. */
  f?: ReportPresetFilters;
  /** Ключи выключенных фильтров. */
  d?: string[];
  /** Короткая подпись набора для кнопки («сентябрь, Д-245»). */
  s?: string;
};

export type ReportLinkMarker = {
  presetId: string;
  filters?: ReportPresetFilters;
  disabled?: string[];
  summary?: string;
};

/**
 * Маркер целиком, включая скобки: `[report:engines?eyJmIjp7...]`.
 * Нагрузка ловится ЛЮБАЯ (до закрывающей скобки, без пробелов), а не только корректная:
 * иначе испорченная моделью строка переставала быть ссылкой вовсе, и оператор не получал
 * даже отчёта без отбора. Разбирает нагрузку уже `parseReportLinkMarker`.
 */
export const REPORT_MARKER_RE = /\[report:([a-z0-9_]+)(?:\?([^\]\s]*))?\]/gi;

const MAX_PAYLOAD_CHARS = 3000;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(text, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string | null {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    if (typeof atob === 'function') {
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Собирает маркер со ссылкой на отчёт. Без настроек — короткая форма `[report:id]`,
 * с настройками — с нагрузкой. Слишком объёмный набор (например, полный список складов)
 * отдаётся короткой формой: оператору лучше отчёт без отбора, чем обрезанный маркер.
 */
export function buildReportLinkMarker(
  presetId: string,
  args?: { filters?: ReportPresetFilters; disabled?: string[]; summary?: string },
): string {
  const id = String(presetId ?? '').trim();
  if (!id) return '';
  const filters = args?.filters && Object.keys(args.filters).length > 0 ? args.filters : undefined;
  const disabled = args?.disabled && args.disabled.length > 0 ? args.disabled : undefined;
  const summary = String(args?.summary ?? '').trim() || undefined;
  if (!filters && !disabled) return `[report:${id}]`;
  const payload: ReportLinkPayload = {
    ...(filters ? { f: filters } : {}),
    ...(disabled ? { d: disabled } : {}),
    ...(summary ? { s: summary.slice(0, 200) } : {}),
  };
  let encoded: string;
  try {
    encoded = toBase64Url(JSON.stringify(payload));
  } catch {
    return `[report:${id}]`;
  }
  if (encoded.length > MAX_PAYLOAD_CHARS) return `[report:${id}]`;
  return `[report:${id}?${encoded}]`;
}

/** Разбирает один маркер. Битая нагрузка не отбрасывает ссылку: остаётся отчёт без настроек. */
export function parseReportLinkMarker(presetId: string, encoded?: string | null): ReportLinkMarker {
  const id = String(presetId ?? '').trim().toLowerCase();
  const raw = String(encoded ?? '').trim();
  if (!raw) return { presetId: id };
  // Не base64url — значит нагрузку испортили по дороге; ссылка остаётся, отбор пропадает.
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return { presetId: id };
  const json = fromBase64Url(raw);
  if (!json) return { presetId: id };
  try {
    const parsed = JSON.parse(json) as ReportLinkPayload;
    if (!parsed || typeof parsed !== 'object') return { presetId: id };
    const filters =
      parsed.f && typeof parsed.f === 'object' && !Array.isArray(parsed.f) ? (parsed.f as ReportPresetFilters) : undefined;
    const disabled = Array.isArray(parsed.d)
      ? parsed.d.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 50)
      : undefined;
    const summary = typeof parsed.s === 'string' ? parsed.s.trim().slice(0, 200) : undefined;
    return {
      presetId: id,
      ...(filters ? { filters } : {}),
      ...(disabled && disabled.length > 0 ? { disabled } : {}),
      ...(summary ? { summary } : {}),
    };
  } catch {
    return { presetId: id };
  }
}

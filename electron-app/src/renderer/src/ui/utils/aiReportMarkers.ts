// Маркеры [report:<id>] и [report:<id>?<настройки>] в ответах ИИваныча: модель вставляет
// готовую строку, которую вернул suggest_report, клиент отрисовывает её кнопкой «Открыть
// отчёт». Неизвестные id не становятся кнопками (id-чурн релизов), но и не показываются
// сырым маркером — просто вычищаются.
//
// Настройки собирает СЕРВЕР (`reportSuggestService`), клиент их только разбирает: испорченная
// нагрузка не отменяет ссылку, отчёт откроется без отбора.

import {
  REPORT_MARKER_RE,
  REPORT_PRESET_DEFINITIONS,
  parseReportLinkMarker,
  resolveReportPresetId,
  type ReportPresetFilters,
} from '@matricarmz/shared';

const KNOWN_IDS = new Set(REPORT_PRESET_DEFINITIONS.map((d) => String(d.id)));
const TITLE_BY_ID = new Map(REPORT_PRESET_DEFINITIONS.map((d) => [String(d.id), d.title]));

export type AiReportLink = {
  presetId: string;
  title: string;
  /** Готовые настройки из маркера: с ними отчёт откроется уже настроенным. */
  filters?: ReportPresetFilters;
  disabled?: string[];
  /** Что именно подставлено, словами — для подписи кнопки. */
  summary?: string;
};

/** Кнопки-ссылки из текста ответа: только существующие пресеты (алиасы резолвятся), без дублей. */
export function extractAiReportLinks(answerText: string): AiReportLink[] {
  const out: AiReportLink[] = [];
  const seen = new Set<string>();
  for (const m of String(answerText ?? '').matchAll(REPORT_MARKER_RE)) {
    const parsed = parseReportLinkMarker(String(m[1] ?? ''), m[2]);
    const presetId = resolveReportPresetId(parsed.presetId);
    if (!KNOWN_IDS.has(presetId) || seen.has(presetId)) continue;
    seen.add(presetId);
    out.push({
      presetId,
      title: TITLE_BY_ID.get(presetId) ?? presetId,
      ...(parsed.filters ? { filters: parsed.filters } : {}),
      ...(parsed.disabled ? { disabled: parsed.disabled } : {}),
      ...(parsed.summary ? { summary: parsed.summary } : {}),
    });
  }
  return out;
}

/** Текст ответа без маркеров (кнопки рисуются отдельно под ответом). */
export function stripAiReportMarkers(answerText: string): string {
  return String(answerText ?? '')
    .replace(REPORT_MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

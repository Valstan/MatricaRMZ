// Маркеры [report:<id>] в ответах ИИваныча (этап 7, 19.08б): модель вставляет
// их по подсказке suggest_report / list_report_presets, клиент отрисовывает
// кнопками «Открыть отчёт». Неизвестные id не становятся кнопками (id-чурн
// релизов), но и не показываются сырым маркером — просто вычищаются.

import { REPORT_PRESET_DEFINITIONS, resolveReportPresetId } from '@matricarmz/shared';

const MARKER_RE = /\[report:([a-z0-9_]+)\]/gi;
const KNOWN_IDS = new Set(REPORT_PRESET_DEFINITIONS.map((d) => String(d.id)));
const TITLE_BY_ID = new Map(REPORT_PRESET_DEFINITIONS.map((d) => [String(d.id), d.title]));

export type AiReportLink = { presetId: string; title: string };

/** Кнопки-ссылки из текста ответа: только существующие пресеты (алиасы резолвятся), без дублей. */
export function extractAiReportLinks(answerText: string): AiReportLink[] {
  const out: AiReportLink[] = [];
  const seen = new Set<string>();
  for (const m of String(answerText ?? '').matchAll(MARKER_RE)) {
    const presetId = resolveReportPresetId(String(m[1] ?? '').toLowerCase());
    if (!KNOWN_IDS.has(presetId) || seen.has(presetId)) continue;
    seen.add(presetId);
    out.push({ presetId, title: TITLE_BY_ID.get(presetId) ?? presetId });
  }
  return out;
}

/** Текст ответа без маркеров (кнопки рисуются отдельно под ответом). */
export function stripAiReportMarkers(answerText: string): string {
  return String(answerText ?? '')
    .replace(MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

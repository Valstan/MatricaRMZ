// Телеметрия использования UI → audit_log (синкается на сервер, виден суперадмину
// в «Журнале действий»; еженедельно агрегируется AI-рутиной в дайджест — задача E
// плана ai-chat-ux-drafts-telemetry-2026-07). Пишем факты навигации, не каждый клик:
// визиты вкладок, открытия карточек, открытия отчётов. Троттлинг гасит дребезг
// (перещёлкивание туда-сюда), fire-and-forget — телеметрия никогда не мешает работе.

const lastSent = new Map<string, number>();
const THROTTLE_MS = 30_000;

const MAX_EXTRA_JSON = 2000;

export function logUiUsage(
  action: 'ui.visit' | 'ui.card_open' | 'ui.report_open' | 'ui.report_build',
  label: string,
  // entityId нужен «Истории изменений этого документа» и вопросу владельца «кто
  // смотрел эту карточку»: до v3.6.0 писался только ВИД карточки («engine»), и
  // ответить, какую именно открывали, было нечем.
  entityId?: string | null,
  // Доп. поля payload (этап 7, 19.08б): ui.report_build несёт санитизированную
  // карту фильтров — сырьё для «популярных настроек» и статистики ИИваныча.
  extra?: Record<string, unknown>,
) {
  const id = String(entityId ?? '').trim();
  // Троттлинг по конкретной карточке, а не по её виду: иначе открытие второго
  // двигателя в пределах 30 с молча не попадало бы в журнал.
  const key = `${action}|${label}|${id}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return;
  lastSent.set(key, now);
  let safeExtra: Record<string, unknown> | undefined;
  if (extra) {
    try {
      if (JSON.stringify(extra).length <= MAX_EXTRA_JSON) safeExtra = extra;
    } catch {
      // несериализуемое — не пишем
    }
  }
  try {
    void window.matrica.audit.add({
      action,
      payload: { label, ...(safeExtra ?? {}) },
      ...(id ? { entityId: id, tableName: 'entities' } : {}),
    });
  } catch {
    // best-effort
  }
}

/**
 * Санитизированная карта фильтров для телеметрии ui.report_build: только
 * скаляры и короткие массивы строк — без свободного текста длиннее 120 симв.
 */
export function sanitizeReportFilterMap(filters: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (n >= 30) break;
    if (value == null) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      n += 1;
    } else if (typeof value === 'string') {
      const v = value.trim();
      if (v && v.length <= 120) {
        out[key] = v;
        n += 1;
      }
    } else if (Array.isArray(value)) {
      const arr = value.map((x) => String(x ?? '').trim()).filter((x) => x && x.length <= 80);
      if (arr.length > 0 && arr.length <= 20) {
        out[key] = arr;
        n += 1;
      }
    }
  }
  return out;
}

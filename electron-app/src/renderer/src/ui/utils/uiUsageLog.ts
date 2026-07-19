// Телеметрия использования UI → audit_log (синкается на сервер, виден суперадмину
// в «Журнале действий»; еженедельно агрегируется AI-рутиной в дайджест — задача E
// плана ai-chat-ux-drafts-telemetry-2026-07). Пишем факты навигации, не каждый клик:
// визиты вкладок, открытия карточек, открытия отчётов. Троттлинг гасит дребезг
// (перещёлкивание туда-сюда), fire-and-forget — телеметрия никогда не мешает работе.

const lastSent = new Map<string, number>();
const THROTTLE_MS = 30_000;

export function logUiUsage(action: 'ui.visit' | 'ui.card_open' | 'ui.report_open', label: string) {
  const key = `${action}|${label}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return;
  lastSent.set(key, now);
  try {
    void window.matrica.audit.add({ action, payload: { label } });
  } catch {
    // best-effort
  }
}

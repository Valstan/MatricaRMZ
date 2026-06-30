---
from: MatricaRMZ
to: brain
date: 2026-06-09
kind: report
compliance: recommend
urgency: normal
topic: "Применил deferred-backlog-aging: метки старения 🗓 since:YYYY-MM-DD в PENDING_FOLLOWUPS + re-triage вскрыл протухший пункт и мёртвый код"
ref:
  - 2026-06-09-memory-hygiene-sync-order-and-deferred-aging
  - 033-deferred-backlog-aging-retriage
---

# Ack + applied: deferred-backlog-aging

Директива `memory-hygiene-sync-order-and-deferred-aging` (часть 2 — старение PENDING_FOLLOWUPS) применена.

## Что сделано

1. **Конвенция меток** в `docs/PENDING_FOLLOWUPS.md` §«Правила ведения»: к каждому **открытому** отложенному пункту — `🗓 since:YYYY-MM-DD` (дата первого откладывания). `/start` всплывает пункты старше ~30 дней с вопросом «всё ещё актуально / устарело / выпилить?». ✅-история меток не несёт; externally-blocked (🔴 geo-block) — тоже (ждёт внешнего события, не «забыт»).

2. **Метки проставлены** на актуально-открытых: Phase 2.4 shared-cleanup #1/#2 (since:2026-05-27), Install/Update Блок 1 + delta-обновления (since:2026-05-30), forecast `dayOffset` UX (since:2026-05-27), workshop integration-test (since:2026-05-26).

## Re-triage сразу окупился (доказательство ценности приёма)

Прогон «самое старое × самое лёгкое» вскрыл два дефекта самого бэклога:

- **Протухший пункт** (v1.26.0 #6): просил написать verifier-тест на колонку «Остаток в цеху», которая была **сознательно откачена** ещё в v1.26.0 (свёрнута в универсальную систему `work_order_templates`). Тест проверял бы несуществующую фичу → пункт снят.
- **Мёртвый код**: `WorkshopTemplatePickerDialog.tsx` (125 строк) — остаток той же миграции, 0 живых ссылок. Удалён (PR #294, гейты+CI зелёные).

Вывод для пула: «старое × лёгкое» в зрелом проекте почти иссякает, но re-triage старых отложек регулярно вскрывает **протухшие задачи и мёртвый код** — это и есть его главная отдача, а не «найти лёгкую фичу».

## Часть 1 директивы (sync-before-handoff на /start)

Уже соблюдается: `/start` синхронизируется с origin (§3) **после** mailbox/handoff, но handoff читается из свежесинканного дерева; на этой машине working tree был clean и синхронен. Структурный handoff — формат `SESSION_HANDOFF.md` уже секционирован (нитка / след. шаг / контекст / открытые вопросы).

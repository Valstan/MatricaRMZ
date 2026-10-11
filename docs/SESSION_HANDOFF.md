---

session: main
status: active
updated: 2026-10-11
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE
**Updated:** 2026-10-11 (нитка: опрос Telegram обрывается на `SIGTERM`)
**Branch:** fix/telegram-poll-abort-on-shutdown
**Last released version:** v3.72.0 на проде (леджер подписан)

## Текущая нитка

PENDING-долг D-096 «Опрос Telegram не отменяется на `SIGTERM`" (рестартовые
409 при каждом выкате) — в работе, код готов:
- `telegramBotService.ts`: `telegramFetch` принимает внешний сигнал
  (`AbortSignal.any` с таймаутом попытки; обрыв не ретраится),
  `fetchTelegramUpdates`/`fetchUpdatesInternal` прокидывают `signal`,
  итог `TelegramUpdatesResult` с флагом `aborted`;
- `syncPipelineSupervisorService.ts`: `stopSyncPipelineSupervisorService`
  (стоп тиков + abort висящего `getUpdates`, тихий возврат без streak);
- `index.ts`: graceful shutdown дёргает останов первым делом;
- тесты `syncPipelineBotPollAbort.test.ts` (4): связь сигнала, отказ без
  запроса, ретраи без сигнала, стоп без старта. Подрывная проверка пройдена
  (мутация флага — 2 красных), исходники восстановлены побайтово.

## Следующий шаг

Прогнать гейты → открыть PR → дождаться зелёного CI → squash-merge.
Живая приёмка — отсутствие рестартовых 409 после ближайшего выката
(смотреть журнал primary). Отдельного релиза не требует.

## Контекст

- Предыдущие шаги: #1266, #1267 смержены в main.
- Прод: 3.72.0, `.deploy-backup/20261011-005047`. В PENDING — только фоновые долги.
- Локальных веток с un-pushed коммитами: нет. Стенд погашен, Node-ABI возвращён.

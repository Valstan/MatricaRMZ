# Session Handoff

> Sticky-note для непрерывности разработки между сессиями и компьютерами. Перезаписывается целиком командой `/close_session`. История — через `git log -- docs/SESSION_HANDOFF.md`.
>
> Если работы в потоке нет — `Status: IDLE` и пустые секции. Команда `/start` это увидит и не будет ничего навязывать.

**Status:** ACTIVE
**Updated:** 2026-07-19 (Claude session, машина `PC40`)
**Branch:** `main` = `origin/main`.
**Last released version:** **v2026.719.1555** (асинхронный AI-чат; статус раскатки — см. тело релизного PR).

## Текущая нитка

**Асинхронный AI-чат** — код отгружен целиком (PR #277–#281 + релиз v2026.719.1555), план [`ai-chat-async-2026-07`](plans/ai-chat-async-2026-07.md). Остался **запуск рутины** (Ф6, ручная часть — [`ai-chat/ROUTINE.md`](ai-chat/ROUTINE.md)):

1. На проде: сотрудник `ai-agent` (login `ai-agent`, роль admin) — актор ответов; без него runner пишет от суперадмина.
2. Залить seed правил: `node dist/scripts/aiChatRoutineIO.js set-rules --file docs/ai-chat/RULES.seed.md --changed-by owner-seed`.
3. (Опц.) PG-роль `ai_readonly` (SELECT-only) для прямых SELECT рутины.
4. Scheduled-агент claude.ai по промпту ROUTINE.md, cron `0 5-14 * * 1-5` UTC.
5. Первый запуск — под присмотром.

## Следующий шаг

Проверить первый реальный цикл рутины (вопрос оператора → ответ в клиенте) и собрать отзыв операторов по v2026.719.1555.

## Контекст

- Runner на проде: `backend-api/dist/scripts/aiChatRoutineIO.js` (list-pending / post-answer / escalate / get-rules / set-rules / mark-run). Записи — только через ledger (`writeSyncChanges`, actor ai-agent, allowSyncConflicts).
- Гейты: 5 вопросов/час (push-guard в транзакции), правки только pending, вердикт — суперадмин; trusted-bypass для серверных записей и ledger-replay.
- E2E CDP-смоук пройден (драйвер `.verifier-electron/_ai-chat-smoke.mjs`, грабли — в профиле PC40).

## Открытые вопросы для пользователя

- Отзыв операторов по live-экранам/группировкам (v2026.719.1157) и AI-чату (v2026.719.1555).
- Планшет для цеха: Windows vs Android — решение не принято ([`plans/tablet-shop-floor.md`](plans/tablet-shop-floor.md)).
- Распределённые серверы: тёплый standby в LAN — по сигналу владельца.

## Не забыть (low-priority)

1. Ledger release-token — exp **2026-08-15**; ротация ≤ ~2026-08-12 (PENDING §Ротация).
2. Ротация SSH-ключей прода — до 2026-08-21.
3. Мастера жмут «Выдать в работу» на ремнарядах, иначе прогноз/комплектование неполны.
4. deadcode-прогон — ~2026-08-04; кандидат: старая синхронная aiAgent-поверхность (SSE/conversations) — UI её больше не зовёт.
5. Ф2 де-дуп `blank-synthetic-codes` — ждёт переустановки клиентов на 5 машинах; перепроверка ~2026-07-24.
6. Бэкап-таблицы на проде (`*_bak_20260717`, `*_bak_norms20260717`) — снести ~август.
7. Флак `ledgerStore.concurrency.test.ts` под параллельной нагрузкой — если повторится, завести пунктом.

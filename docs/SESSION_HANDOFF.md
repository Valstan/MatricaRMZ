---

session: main
status: active
updated: 2026-10-11
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE
**Updated:** 2026-10-11 (нитка: heartbeat push по id машины, M102)
**Branch:** fix/push-client-id
**Last released version:** v3.72.0 на проде (леджер подписан)

## Текущая нитка

M102 «`sync_state.client_id` при push — id аккаунта» — в работе, код готов:
клиент шлёт `client_id` в теле `/ledger/tx/submit` (Android наследует
общий `runSync`), сервер тянет через `applyLedgerTxs → writeSyncChanges →
applyPushBatch` с откатом на id. Миграция `sync:merge-account-rows`
(dry-run, идемпотентна): 8 однозначных слить, остальные удалить.
Замер прода: 162 строки, 28 uuid-only (27 в users). Тесты:
`pushClientId.test.ts` (2) + `mergeSyncStateAccountRows.test.ts` (7) +
`client_id` в android-смоуке. Подрывы пройдены. Dry-run скрипта на
dev-БД — exit 0. Остаток — dry-run + `--apply` на проде окном владельца.

## Следующий шаг

Прогнать гейты → открыть PR → дождаться зелёного CI → squash-merge →
дописать строку COMPLETED. CDP-смоук не гнался: протокол синхронизации
закрыт тестами, стенд не требуется.

## Контекст

- Предыдущие шаги: #1266–#1278 смержены в main (строки COMPLETED уже в main).
- Прод: 3.72.0, `.deploy-backup/20261011-005047`. В PENDING — только фоновые долги.
- Локальных веток с un-pushed коммитами: нет. Стенд погашен, Node-ABI возвращён.

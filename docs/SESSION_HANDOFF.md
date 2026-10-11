---

session: main
status: active
updated: 2026-10-11
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE
**Updated:** 2026-10-11 (нитка: `immutable` для ассетов админки)
**Branch:** fix/web-admin-immutable-cache
**Last released version:** v3.72.0 на проде (леджер подписан)

## Текущая нитка

Долг D-096 «`immutable` не включён нигде» (идея #250) — в работе, код готов:
`/admin-ui/assets` отдаются с `maxAge: '1y', immutable: true` (отдельный
маунт до общего), `index.html` — с явным `no-cache` (и из статики через
`setHeaders`, и из SPA-фолбэка). Сторож `webAdminCacheHeaders.guard.test.ts`
текстовый сознательно: в CI `web-admin/dist` не собирается, живой supertest
дал бы 404; механика `express.static` — контракт Express. Подрывная
проверка: `immutable: false` роняет сторож. PENDING-пункт помечен закрытым.

## Следующий шаг

Прогнать гейты → открыть PR → дождаться зелёного CI → squash-merge →
дописать строку COMPLETED. Отдельного релиза не требует (сработает
со следующим выкатом backend-дистрибутива). CDP-смоук не гнался:
серверные заголовки, стенд не требуется.

## Контекст

- Предыдущие шаги: #1266, #1267, #1268, #1269, #1270, #1271 смержены в main
  (строки COMPLETED за #1268–#1271 уже в main).
- Прод: 3.72.0, `.deploy-backup/20261011-005047`. В PENDING — только фоновые долги.
- Локальных веток с un-pushed коммитами: нет. Стенд погашен, Node-ABI возвращён.

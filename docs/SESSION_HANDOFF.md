---

session: chore/b2-b1-leftovers
status: active
updated: 2026-10-03
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`.

**Status:** ACTIVE
**Updated:** 2026-10-03 (мелкие хвосты B1/B2 в работе, PR не открыт)
**Branch:** chore/b2-b1-leftovers
**Last released version:** v3.60.0 на проде (платежи строгие смержены как #1136)

## Текущая нитка

Мелкие хвосты B1/B2 из плана `matrica-v4-kickoff-2026-08.md`: снос мёртвых `ErpSyncTableName`/`erpSyncRowSchemaByTable`, снос `backfillDirectoryEngineBrands.ts`, `repairNormService` на строгое зеркало, AI `getReclamations` на зеркало с EAV-фолбэком. assemblyPlanning оставлен осознанно (читает карточку двигателя = домен B4).

## Контекст

- PR #1136 (платежи) смержен squash'ем e64c3ef7, ветка удалена
- Дальше по B2: cutover CRUD договоров (REST-дверь по образцу section_access?) и уникальность number (ждёт решения владельца); затем B4 двигатели (XL)

## Открытые вопросы для пользователя

- Нет

## Не забыть (low-priority)

- `user_settings`/`user_credentials` сознательно вне sync-контракта (сторож в CI); не предлагать их «досинкать».
- `listEmployeesAuth` остаётся на EAV (сырая роль для roleReport) — не «забытый хвост», а решение.
- Freeze EAV-платежей и снос триггера зеркала — после обновления парка (предусловия как у R4b).
- CDP-смоук правки платежа — перед релизом с платежами.

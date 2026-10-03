---

session: feat/contract-cutover-c4
status: active
updated: 2026-10-03
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`.

**Status:** ACTIVE
**Updated:** 2026-10-03 (C4 готов, стек-PR не открыт)
**Branch:** feat/contract-cutover-c4 (стеком на feat/contract-cutover-c3 = PR #1140)
**Last released version:** v3.60.0 на проде

## Текущая нитка

Cutover договоров/контрагентов (план `docs/plans/contract-cutover-2026-10.md`): C4 — `contracts:parity` (обе стороны вживую), `payments:parity` strict-extra → info, `importContractsGoz` на дверях. Одноразовые скрипты оставлены на EAV осознанно (разбор на C5). Гейты: backend typecheck/lint чистые.

## Контекст

- #1138 смержен (C1+C2+dual-write), #1140 открыт (C3)
- Стек чинился руками после мержа #1138 (rebase-конфликт + закрытый PR; правило: после мержа базы стек пересобирать cherry-pick, PR открывать заново)
- Дальше: C5 freeze после обновления парка; уникальность number ждёт владельца

## Открытые вопросы для пользователя

- Нет: уникальность номеров закрыта решением выше (оставить тройку, гейт смягчён)

## Не забыть (low-priority)

- `user_settings`/`user_credentials` сознательно вне sync-контракта (сторож в CI); не предлагать их «досинкать».
- `listEmployeesAuth` остаётся на EAV (сырая роль для roleReport) — не «забытый хвост», а решение.
- Freeze EAV-платежей и снос триггера зеркала — после обновления парка.
- CDP-смоук карточки договора и правки платежа — перед релизом с cutover.

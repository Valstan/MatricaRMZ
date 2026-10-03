---

session: feat/contract-cutover-c1
status: active
updated: 2026-10-03
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`.

**Status:** ACTIVE
**Updated:** 2026-10-03 (cutover договоров C1+C2 готовы, PR не открыт)
**Branch:** feat/contract-cutover-c1
**Last released version:** v3.60.0 на проде (#1136 платежи и #1137 хвосты смержены)

## Текущая нитка

Cutover договоров/контрагентов (план `docs/plans/contract-cutover-2026-10.md`): C1 (серверные двери, доказаны вживую) + C2 (карточка контрагента → двери, тесты IPC 5/5). Гейты: backend 967, shared 1281; electron полный: 1393 зелёных + 1 известный флейк clientOpsArchive (в одиночку зелёный).

## Контекст

- C1: `contractStrictService` + `routes/contracts` (create/patch/get ×2), гейт `contracts.edit`, гейт дублей, entities публикуются сразу, strict — pending под публикатор
- C2: `register/contracts` IPC + preload + MatricaApi + карточка + quickCreate; write-through synced в реплику
- Дальше: C3 карточка договора → двери (самая большая часть), C4 скрипты + parity, C5 freeze после обновления парка

## Открытые вопросы для пользователя

- Уникальность `erp_contracts.number`: дубли «20/ГОЗ-25» — какой канонический, решение владельца
- Открывать PR на C1+C2 сейчас или вместе с C3?

## Не забыть (low-priority)

- `user_settings`/`user_credentials` сознательно вне sync-контракта (сторож в CI); не предлагать их «досинкать».
- `listEmployeesAuth` остаётся на EAV (сырая роль для roleReport) — не «забытый хвост», а решение.
- Freeze EAV-платежей и снос триггера зеркала — после обновления парка.
- CDP-смоук правки платежа — перед релизом с платежами.

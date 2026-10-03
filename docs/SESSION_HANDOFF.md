---

session: feat/contract-cutover-c3
status: active
updated: 2026-10-03
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`.

**Status:** ACTIVE
**Updated:** 2026-10-03 (cutover договоров C3 готов, стек-PR не открыт)
**Branch:** feat/contract-cutover-c3 (стеком на feat/contract-cutover-c1 = PR #1138)
**Last released version:** v3.60.0 на проде

## Текущая нитка

Cutover договоров/контрагентов (план `docs/plans/contract-cutover-2026-10.md`): C3 — карточка договора → двери. IPC `contracts:contract:*`, синтезированные атрибуты (downstream цел), saveSections одним патчем, платежи из стора, copyToNew ×2 и createMasterDataItem через двери. В EAV остались только вложения/has_files/произвольные дефы. Dual-write ушёл в #1138. Гейты: electron 1396 зелёных, lint/typecheck чистые.

## Контекст

- C1+C2 + dual-write — в PR #1138 (CI чинился: неиспользуемые actor/type; локально гонять `pnpm -r lint` целиком)
- Дальше: C4 скрипты + contracts:parity, C5 freeze после обновления парка
- Латентный вайп strict-платежей устаревшим EAV в сверке слотов — закрыт чтением из стора

## Открытые вопросы для пользователя

- Уникальность `erp_contracts.number`: дубли «20/ГОЗ-25» — какой канонический, решение владельца

## Не забыть (low-priority)

- `user_settings`/`user_credentials` сознательно вне sync-контракта (сторож в CI); не предлагать их «досинкать».
- `listEmployeesAuth` остаётся на EAV (сырая роль для roleReport) — не «забытый хвост», а решение.
- Freeze EAV-платежей и снос триггера зеркала — после обновления парка.
- CDP-смоук правки платежа и карточки договора — перед релизом с cutover.

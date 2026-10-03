---

session: main
status: active
updated: 2026-10-03
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`.

**Status:** ACTIVE
**Updated:** 2026-10-04 (OpenCode session, на машине PC79)
**Branch:** feat/engine-doors-e2
**Last released version:** v3.60.0 на проде

## Текущая нитка

Трек B (EAV→строгие): B2 cutover договоров закрыт C1–C4 (остался C5-freeze — ждёт обновления парка), B4/E1-зеркало двигателей смержено (#1143). E2 (серверные двери карточки двигателя) готов на ветке `feat/engine-doors-e2`: `engineStrictService` (патч 57 полей + get) + маршруты + 13 тестов + живая проверка на PG. Уникальность номеров закрыта решением владельца.

## Следующий шаг

1. Открыть PR E2, дождаться CI, смержить; обновить handoff.
2. Дальше — E3 (клиент `EngineDetailsPage` → двери; решить push-vs-REST: карточка правится в цеху с планшета — офлайн нужен; вход `erp_engine_cards` в sync-контракт — тоже E3).

## Контекст

- План B2: `docs/plans/contract-cutover-2026-10.md` (C1–C4); план B4: `docs/plans/engine-cards-strict-2026-10.md` (E1 ✅, E2 готов)
- Смержено 03.10: #1136 (платежи), #1137 (хвосты B1/B2), #1138 (C1+C2+dual-write), #1140 (C3), #1142 (C4 + послабление гейта), #1143 (B4/E1)
- #1143 конфликтовал с main после #1142 (package.json: две parity-строки) — разрешён merge'ом main в ветку (1 файл, обе строки), не cherry-pick: ветка однокоммитная, путать head'ы не с чем. CI-флейк `workOrderListCache` (1/1396) — одиночно зелёный, перезапуск CI зелёный.
- Прод: v3.60.0; миграции 0104/0105 на проде НЕ применены (релиза с ними не было)
- Локальные ветки с un-pushed коммитами: нет (только `feat/engine-doors-e2`, запушена после коммита)

## Что не сработало

- Стек PR после мержа базы чинить rebase'ом — тупик: закрытые PR и перепутанные head'ы (#1142 оказался на c4). Рабочий путь: cherry-pick нужных коммитов на свежие ветки от main + новые PR (так пересобраны #1140→#1142/#1143).
- Кавычки в ssh-команде до прода не доезжают (PowerShell): SQL — только файлом через `scp` + `psql -f`, без кавычек в команде.

## Открытые вопросы для пользователя

- Нет.

## Не забыть (low-priority)

- `user_settings`/`user_credentials` сознательно вне sync-контракта (сторож в CI); не предлагать их «досинкать».
- `listEmployeesAuth` остаётся на EAV (сырая роль для roleReport) — не «забытый хвост», а решение.
- C5-freeze (договоры + платежи) и E5-freeze (двигатели) — после обновления парка; preconditions: parity зелёный + версии клиентов по `client_settings.lastVersion`.
- CDP-смоук карточки договора и правки платежа — перед релизом с cutover.
- Одноразовые скрипты на EAV (`mergeCounterparties`, `seedPortfolioDemo`, `importEngine*`, `resyncContractSlots`, `canonicalize`) при freeze упадут громко — разбирать на C5.

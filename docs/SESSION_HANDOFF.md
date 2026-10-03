---

session: main
status: active
updated: 2026-10-03
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`.

**Status:** ACTIVE
**Updated:** 2026-10-04 (OpenCode session, на машине PC79)
**Branch:** main
**Last released version:** v3.60.0 на проде

## Текущая нитка

Трек B: B2 закрыт C1–C4, B4: E1 ✅, E2 ✅, E3a ✅ (контракт + серверный приём + реплика/чтение, #1147). Карточка грузится/пишется по-старому (EAV). Следующий шаг — E3b (запись/push/heal + карточка + смоук).

## Следующий шаг

E3b на новой ветке от main: клиент SAVE → реплика pending + push + heal (error + notify), клиентские гейты перед записью, `EngineDetailsPage` LOAD (реплика + EAV-фолбэк) и SAVE одним патчем, CDP-смоук карточки. Write-through — только серверной строкой (GET после save), иначе stale-база заткнёт чужие правки.

## Контекст

- План B4: `docs/plans/engine-cards-strict-2026-10.md` (E1 ✅, E2 ✅, E3a ✅, E3b описан)
- Смержено 03–04.10: #1136, #1137, #1138, #1140, #1142, #1143 (B4/E1), #1145 (B4/E2), #1146 (handoff), #1147 (B4/E3a)
- E3a-находки (в коде): след только post-commit (внутри apply-транзакции — кросс-коннект deadlock с триггером зеркала); pre-sign гейт номера/пары; authz `permission+engines.edit` (проверено вживую, в т.ч. отказ viewer)
- Стенд-грабли: убитый по таймауту tsx оставляет висячую PG-транзакцию — следующий прогон встаёт за ней; чистить `Stop-Process` + проверять `pg_stat_activity`. tsx-скриптам живых проверок — явный `process.exit` (импорты держат хендлы)
- Прод: v3.60.0; миграции 0104/0105 на проде НЕ применены (релиза с ними не было)
- Локальные ветки с un-pushed коммитами: нет

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

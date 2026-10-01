# Session Handoff

> Sticky-note для непрерывности разработки между сессиями и компьютерами. Обновляется в PR каждого шага нитки (D-066); `/close_session` — страховка. История — через `git log -- docs/SESSION_HANDOFF.md`.

**Status:** ACTIVE
**Updated:** 2026-10-01 (машина `PC79`) — задача владельца от 01.10 в четырёх PR: PR-A (#1092) и PR-B (#1093) влиты, PR-C (единая лента истории ремонта) в работе, дальше PR-D (ступени этапов в отчётах).
**Branch:** `feat/engine-single-history-feed` (PR-C)
**Last released version:** **v3.54.0**, выкачено 01.10 · ledger-токен до 2026-10-28

## Текущая нитка

Задача владельца 01.10 в четырёх PR по плану
[`plans/engine-card-order-actor-history-facets-2026-10.md`](plans/engine-card-order-actor-history-facets-2026-10.md):

- **PR-A (#1092) — влит.** Накладные на вкладке «Основное» вплотную к датам. Корень: порядок
  задаёт массив `desired` (`persistFieldOrder` перезаписывает `sortOrder` по нему), а не
  `f.order` из shared. Сторож `EngineDetailsPage.fieldOrder.guard.test.ts`.
- **PR-B (#1093) — влит.** Словарь служебных авторов `shared/src/domain/serviceActors.ts`
  (`serviceActorLabel`). Логины скриптов в базе не меняются — словарь назван словами поверх них.
- **PR-C — в работе.** Три ленты истории → одна: `shared/src/domain/engineHistoryFeed.ts`
  (`buildEngineHistoryFeed`) + панель `EngineHistoryFeedPanel`; удалены
  `EngineRepairHistoryPanel`/`EngineTimelinePanel`/`RepairStagesSection` и их сторожа.
  Колонка «Записано» рядом с датой события — прямое требование владельца.
- **PR-D.** Ступени этапов: оставить «Есть этап» + «Последний этап» + «Дата этапа», убрать
  `historyAction`/`historyDate`/`sheetNode`/`sheetDate`. Нужен `stageCodes` в строке списка.

## Следующий шаг

Открыть PR для PR-C и смержить; дальше PR-D (ступени этапов в отчётах).

## Контекст

- **Прод:** v3.54.0 на обоих инстансах (:3001/:3002 порознь); инсталлятор + blockmap + APK разложены, `latest.json` == `.exe`; `/updates/status` — latest 3.54.0, `lastError: null`; диспетчер предлагает 3.54.0 обеим платформам. Миграций не было.
- **Планы:** активный — [`plans/engine-card-order-actor-history-facets-2026-10.md`](plans/engine-card-order-actor-history-facets-2026-10.md) (PR-A..D). Закрытые: [`plans/bulk-stage-dialog-and-defect-dates-2026-10.md`](plans/bulk-stage-dialog-and-defect-dates-2026-10.md) (#1089, #1090), [`plans/_archive/engine-multiselect-stages-print-2026-09.md`](plans/_archive/engine-multiselect-stages-print-2026-09.md).
- **Открытых PR:** нет. **Локальных веток с неотправленными коммитами:** нет.
- **Письмо brain:** `mailbox/to-brain/2026-10-01-ask-the-cascade-not-the-files.md` (CDP `CSS.getMatchedStylesForNode` против гадания по файлам).
- **Драйверы смоука** — в `.verifier-electron/` (gitignored, только `PC79`): `cdp-prs-smoke.mjs`, `cdp-bulk-stage-search.mjs` (диалог этапа), `cdp-engine-defect-dates.mjs` (даты дефектовки), `cdp-engine-main-field-order.mjs` (порядок полей «Основного»), `cdp-history-actor-labels.mjs` (подписи авторов), `cdp-history-single-feed.mjs` (единая лента истории). Ручную запись истории смоук убирает `DELETE` по `operations` через psql стенда (id печатается в `.verifier-electron/cdp-history-single-feed-purge.txt`): удаления в UI нет и не должно быть, запись только правится. Грабли: вкладки карточки — обычные кнопки `CardTabs`, искать по тексту, а НЕ в `.v3-tab-strip`; порядок полей вкладки «Основное» читать по `.card-row` (строка подпись+значение), сортируя по Y.

## Что не сработало

- **Guard-тест, записанный поверх существующего файла, молча его заменяет** (дважды за сессию: PR-G и PR-H). Файл дописывается чтением + append, а не `Write` целиком; на Windows регистр имени ненадёжен (`PopupLayer` vs `popupLayer` — один файл).
- **`typecheck` не покрывает тест-файлы** — красный CI у #1081 поймал то, что локальный `typecheck` не видит. Гейт = `typecheck` + `typecheck:test`.
- **Кавычки в ssh-команде не доезжают до прода** (только scp-файлом в `/tmp`); `2>/dev/null` и `head`/`tail` в `shell`-туле не работают (PowerShell).
- **Многострочная правка `Edit` не ищется** (CRLF рабочей копии — и в markdown, и в `.tsx`): замена с двумя строками внутри файла не матчится, пока не сократишь до одной. Надёжно — правка скриптом на Node с `replaceOnce` по фактическому EOL файла (`readFileSync` → `.replace` → `writeFileSync`); `flatMap` в `.tsx` при вставке в массив литерaлов даёт вложенный массив и роняет `tsc` — писать через `for` + `push`.

## Открытые вопросы для пользователя

- 145 расходящихся дублей — нужен взгляд владельца (см. `PENDING_FOLLOWUPS.md` §E1).
- Офлайн-копии свёртка ключей (сейф + вне здания) — не сделано.
- Обход машин для «Раздачи соседям» (`PC76`, `PC19`, `PC20`, запасная `PC36`) — ждёт утверждения.

## Не забыть (low-priority)

- Перемер роста диска — срок в календаре `PENDING_FOLLOWUPS`.
- Свежей суточной цифры 409 нет (последний замер 07.09).
- Опрос Telegram не отменяется на `SIGTERM` (рестартовые 409 при выкате).

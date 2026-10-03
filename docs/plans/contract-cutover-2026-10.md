# Договоры и контрагенты: EAV → строгие таблицы (cutover B2)

**Статус:** IN REVIEW (2026-10-03, ветка `feat/contract-cutover-c3` стеком на `feat/contract-cutover-c1`, C3 готов)
**Контекст:** план [matrica-v4-kickoff-2026-08.md](matrica-v4-kickoff-2026-08.md), этап B2. Разведка писателей — в ветке (два explore-прохода).

## Исходное состояние

- Чтения уже на strict: сервер (0084+), клиентские лукапы (реплика, v3.57.0).
- Запись — EAV через синк, strict держится триггерами `rebuild_erp_*`.
- Писатели клиента (всё sync, REST нет): `ContractDetailsPage` (~15 кодов + секции + копии), `CounterpartyDetailsPage` (7 полей + копии), deferred-create через `fallbackTypeId`, `quickCreate` заказчика из карточки договора. Платежи уже strict (#1136).
- Писатели сервера: generic `POST /admin/masterdata/entities/:id/set-attr` (любой код) + скрипты (importContractsGoz, seed, canonicalize, resync, importEngineLedger, importEnginesCsv, mergeCounterparties).

## Решение

REST-двери по образцу R2 (`section_access`): договоры и контрагентов правят в офисе по сети, офлайн-запись им не нужна (та же аргументация, что у доступов). Push-вариант отвергнут: full-row LWW потерял бы Mersgranularity EAV (поле-атрибут), а нормализация секций в строки — overkill.

- Дверь принимает **полевой патч** (как setAttr, но strict-backed): гранулярность сохраняется, конкурентные правки разных полей не затирают друг друга.
- Неизвестное поле — громкий отказ с перечислением (приём R2).
- Запись идёт напрямую в `erp_contracts`/`erp_counterparties` + публикация через `writeSyncChanges` (id генерирует клиент при deferred-create, как строки этапов).
- EAV-триггеры продолжают зеркалить старые клиенты весь переходный период (петли нет: двери EAV не трогают).

## Шаги

- **C1 (сервер):** ✅ **готов 2026-10-03** (`contractStrictService` + `routes/contracts`, тесты, живая проверка на PG). `POST /contracts` (create) + `POST /contracts/:id/patch` (whitelist полей: number, internal_number, goz_*, date/due_date, customer_id, comment, sections, execution_parts) + `POST /counterparties` + `POST /counterparties/:id/patch` (name, short_name, inn, kpp, address, phone, email). Гейт `contracts.edit`, валидация zod, гейт дублей номера, entities публикуются сразу, strict — pending под публикатор. Найдено вживую: entities-триггер кладёт mirror-shell раньше двери — create идёт upsert'ом; прямая публикация server-owned таблиц отбивается backstop'ом (двери на неё не полагаются).
- **C2 (клиент):** ✅ **готов 2026-10-03** — карточка контрагента → двери (`contracts:counterparty:*` IPC: чтение из реплики + EAV-фолбэк, запись REST-дверью, `copyToNew` и `quickCreate` через create с find-or-create по имени). Write-through в локальную реплику со статусом synced (иначе экран откатывался бы до pull; pending висел бы вечно — пуш таблицы отбивает server-managed backstop).
- **C3 (клиент):** ✅ **готов 2026-10-03** — карточка договора → двери (`contracts:contract:*` IPC: чтение из реплики + EAV-фолбэк, запись дверью, write-through; синтезированные атрибуты — downstream не тронут). `saveSections` — один патч вместо семи setAttr (атомарно); платежи читаются из стора (устранён латентный вайп strict-платежей устаревшим EAV); `copyToNew` ×2 и `createMasterDataItem(customer)` через двери. В EAV остались только вложения/has_files/произвольные дефы.
- **C4 (скрипты + приёмка):** `contracts:parity` (EAV↔strict), перевод скриптов-писателей на двери (import/merge/resync/canonicalize; seed остаётся на EAV — dev-стенд).
- **C5 (позже, после обновления парка):** freeze кодов contract/customer в `setEntityAttribute` + push-backstop, снос `rebuild_erp_contract/counterparty` + триггеров (прецедент R4b). Предусловия: parity зелёный + парк на сборке с дверями (по `client_settings.lastVersion`).

## Вне скоупа

- Уникальность `erp_contracts.number` — ждёт решения владельца по дублям «20/ГОЗ-25».
- `contract_sections` остаётся JSON-блобом (как сегодня); его нормализация — не этот план.
- `assemblyPlanningService` читает марку из карточки двигателя — домен B4, не трогаем.

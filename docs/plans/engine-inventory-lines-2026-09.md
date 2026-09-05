# Список деталей двигателя → строгая таблица `erp_engine_inventory_lines`

**Статус:** ACTIVE (2026-09-05). Решение владельца 05.09: перед компакцией ledger'а вынести список деталей из `operations.meta_json` в строгую таблицу. Это первый **push** строгой таблицы с клиентов — тот самый «узел офлайн-записи» из плана v4 ([трек B, сверка 2026-08-27](matrica-v4-kickoff-2026-08.md#ключевая-развилка-найденная-сверкой-узел-офлайн-записи)); механизм строится здесь один раз и дальше закрывает B2-cutover, B4, B5.

## Context

**Замер на проде 05.09 (read-only):** 2293 листа `operation_type='engine_inventory'` на 1939 двигателей (у ~350 двигателей по два и больше листа — дубли эпохи гонки, см. `PENDING` §«Второй прогон rebuild-state»). Средний лист 48 КБ, максимум 255 КБ; в среднем 130 строк деталей, максимум 659; секция `answers.engine_inventory_items` — 50 КБ из 48 (то есть **весь объём — строки**, остальные ответы и вложения — единицы КБ).

**Цена сегодня** (`PENDING` §«Ledger state.json — 194 МБ»): одна галочка в списке = новая версия всего листа целиком в `operations.meta_json` → блок ledger'а с 48–255 КБ шифротекста → `loadState/applyTxs/saveState` всех 218 МБ проекции на каждый append (M79 `bad_alloc`). `operations.meta_json` = 150 из 187 МБ таблиц проекции, из них 139 МБ — `engine_inventory`.

**Форма строки сейчас** (`shared/src/domain/repairChecklist.ts` `EngineInventoryRow` + мета-ключи клиента `electron-app/src/renderer/src/ui/utils/repairChecklistRows.ts`): 12 логических колонок + опциональные `stamped_number`, `in_*_act`, `in_*_act_override`, `scrap_reason` + мета `__brand_source`/`__brand_part_id` (строка из списка деталей марки), `__part_id` (ручной выбор), `__photos` (JSON `FileRef[]`), `__selected` (отметка для печати). Идентичность строки — id детали (`getRowPartId`), fallback — текст-сигнатура.

**Кто читает `answers.engine_inventory_items.rows`** (сверено грепом 05.09): клиент — `RepairChecklistPanel.tsx` (18 мест, единственный писатель), `engineService.ts` (флаги «картер в утиле» / «дефектовка начата»), `reports/presets/engines.ts` (2 пресета), `cardContentSearchService.ts`, `checklists.ts` IPC (`engineInventoryHasDefectData` → авто-статус); сервер — `checklistService.ts` (get/save для web-admin и импорта), скрипт `migrateChecklistToEngineInventory.ts` (отработал), тест `directoryPartsDedupe.test.ts` (серверный дедуп деталей правит `__part_id` внутри payload). Shared-хелперы (`buildSupplyRequestItemsFromInventory`, `buildRepairFundIntakeFromInventory`, `buildStampedInstancesFromInventory`, `listScrapPartNames`, …) принимают **raw-строки** — им всё равно, откуда массив.

## Целевая схема

`erp_engine_inventory_lines` — одна строка = одна деталь одного листа. PG и реплика SQLite (реплика не строже сервера, 0020).

| колонка | тип | из чего |
|---|---|---|
| `id` | uuid PK | новый (бэкфилл — детерминированный uuid v5 от `operation_id + sort_order`, чтобы повторный прогон не плодил строки) |
| `operation_id` | uuid → `operations.id` | родительский лист (остаётся как контейнер прочих ответов и вложений) |
| `engine_entity_id` | uuid → `entities.id` | дублируется из листа ради фильтра по двигателю без join (B4 ещё не сделан, карточка двигателя — EAV) |
| `sort_order` | int | позиция в списке |
| `part_id` | uuid null | `__brand_part_id` либо `__part_id` (id номенклатуры/детали); FK не ставим — у legacy-строк id может указывать в `entities` (детали до Phase 3) |
| `brand_managed` | bool | `__brand_source = 'engine_brand'` |
| `part_name`, `assembly_unit_number`, `part_number`, `stamped_number` | text | как есть |
| `bom_variant_group` | text null | |
| `quantity`, `actual_qty`, `repairable_qty`, `scrap_qty`, `replace_qty` | int | |
| `present` | bool | |
| `replenishment_branch` | text null (CHECK customer/repair/purchase) | |
| `scrap_reason` | text | |
| `in_completeness_act`, `in_defect_act`, `in_completeness_act_override`, `in_defect_act_override` | bool null | null = «не задано» (legacy-строка без флага) |
| `selected` | bool | `__selected` |
| `photos_json` | text null | `__photos` как есть (`FileRef[]`), пусто → null |
| `created_at`, `updated_at`, `deleted_at`, `sync_status`, `last_server_seq` | стандартные sync-колонки | |

Индексы: `(operation_id, sort_order)`, `(engine_entity_id)`, `(part_id)`. Уникальности по `(operation_id, sort_order)` нет: при офлайн-правках двух клиентов порядок может временно совпасть, LWW по `updated_at` решает.

**Инварианты живут в shared:** `normalizeEngineInventoryRow` остаётся единственным местом нормализации; конвертация «строка таблицы ↔ raw-строка listа» — две чистые функции в `shared/src/domain/engineInventoryLines.ts` (`lineFromInventoryRow` / `inventoryRowFromLine`), покрытые round-trip тестом на всех мета-ключах. Все нынешние потребители продолжают получать raw-строки — через `inventoryRowFromLine`.

## Этапы (каждый = обычный релизный цикл v3)

### E1 — сервер + shared: таблица, синк-контракт, бэкфилл, серверная запись

**Код слит 05.09 (PR этого этапа); на проде не применён** — `db:migrate` (0090) и бэкфилл ждут OK владельца, см. `PENDING` §«Список деталей → строгая таблица». Вместе с E1 сделан **E2.1** (реплика на клиенте в обеих цепочках + применение pull): клиент этого репо собирается с новым `shared`, и без реплики холодный full-state упал бы на неизвестной таблице. Отступления от текста ниже: серверный вывод строк вынесен не в `applyPushBatch`, а в `writeSyncChanges` (шаг 4, после PG) — из **применённых** листов, чтобы не выводить строки из отброшенного как устаревший листа; в таблицу добавлена колонка `line_key` (ключ сверки внутри листа: id детали, иначе текст-сигнатура, дубли — с суффиксом), а `id` строки — детерминированный uuid v5 от (лист, ключ), так что бэкфилл идемпотентен, а reorder не плодит строк. Правило E2.4 («лист, для которого в батче есть строки таблицы, не выводится») реализовано сразу.

1. Shared: `SyncTableName.ErpEngineInventoryLines`, zod-схема строки, `FieldMapping`, запись реестра (`dependsOn: [Operations]`), раздел `Production` в `sectionAccess`, домен `engineInventoryLines.ts` + тесты.
2. Ledger: `LedgerTableName.ErpEngineInventoryLines`; таблица в `emptyLedgerState()`.
3. Backend: Drizzle-схема, миграция `0090_engine_inventory_lines.sql` (только `CREATE TABLE` + индексы, без триггеров — источник строк не EAV, а JSON, триггер на `meta_json` был бы вторым парсером), `PG_SYNC_TABLES` + `pullChangesSince` (обе карты, сторож `usersContractDrift` знает список расхождений), `LEGACY_SCHEMA_SNAPSHOT_TABLES` не трогать (старые сборки таблицу не знают — и не должны).
4. Backend: `applyPushBatch` — секция для таблицы (generic upsert по реестру, LWW по seq/updated_at, dependency `operation_id` → `operations`). **Плюс серверный вывод строк из пришедшего листа:** после upsert `operations` с `operation_type='engine_inventory'` строки таблицы пересобираются из `meta_json` (`syncEngineInventoryLinesFromPayload`), пока старые клиенты пишут только JSON. Тот же вызов — в `checklistService.save` (web-admin). Пересборка идёт через `writeSyncChanges`, чтобы строки попали в ledger и в инкрементальный pull (разрыв «server-write мимо writeSyncChanges» из сверки 27.08 здесь не повторяем).
5. Backend: скрипт `engine-inventory:backfill-lines` (dry-run по умолчанию, `--apply`): по всем живым листам — детерминированные id, вставка через `writeSyncChanges` пачками; отчёт «листов / строк / пропущено (без rows)». Идемпотентен: повторный прогон обновляет, не дублирует.
6. Гейты + PR. **Прод:** `db:migrate` (0090) и бэкфилл — по явному OK владельца, вне окна бэкапа; бэкфилл ~300 тыс. строк = ~300 блоков ledger'а по ~1000 транзакций, прогон в ночное окно с `NODE_OPTIONS`.

### E2 — клиент: реплика, pull, чтение из таблицы, push (следующий релиз клиента)

1. Реплика в **обеих** цепочках (`electron-app/drizzle/0023_*.sql` + `ensureClientSchemaParity` в `migrate.ts`; версионную цепочку не бампать — прецедент 0022), `sectionGate`, `FULL_STATE_SYNC_TABLES` подхватит из реестра.
2. Чтение: `checklists:engine:get` собирает `answers.engine_inventory_items.rows` из реплики таблицы, если строки есть; иначе — из `meta_json` (двигатели, которых бэкфилл не коснулся, и офлайн-клиенты до первого pull). Потребители (`engineService`, отчёты, поиск) — через один хелпер `readEngineInventoryRows(db, engineId)`.
3. Запись: панель сохраняет как раньше (весь `answers`), а `saveRepairChecklistForEngine` на клиенте (а) пишет строки в реплику с `sync_status='pending'` (diff по id: изменённые/новые/удалённые → тумстоуны), (б) **пока** продолжает писать `rows` и в `meta_json` — это оставляет старые клиенты и серверный вывод (E1 п. 4) согласованными. Push таблицы идёт штатным `pushPending` по реестру.
4. Сервер при push от **нового** клиента: строки приходят напрямую, серверный вывод из `meta_json` для того же листа не должен их перетирать → в `applyPushBatch` вывод из JSON делается только если в том же батче нет строк таблицы для этого `operation_id`, и только для листов, у которых в таблице ещё нет строк (иначе — LWW между версиями листа и версиями строк).
5. Релиз клиента; парк обновляется (метрика та же, что у R4b).

### E3 — флип: строки только в таблице

1. Клиент перестаёт класть `rows` в `meta_json` (оставляет `{kind:'table', rows: []}` + маркер `rowsIn: 'erp_engine_inventory_lines'`), серверный вывод из JSON выключается для листов с маркером.
2. Рычаг 426 для сборок ниже E2-версии (иначе старый клиент запишет пустой список поверх).
3. Одноразовый скрипт: вычистить `rows` из `meta_json` существующих листов на проде (после чего `operations.meta_json` теряет ~140 МБ) — и вот тогда компакция ledger'а имеет что показать: `resnapshot-state` до/после, критерий `PENDING` §«Второй прогон», п. 6.

## Что сознательно не делаем

- Не переносим остальные ответы листа (комиссия, состояние при поступлении, гриф, подписи, вложения): они малы и живут в `meta_json` дальше. Таблица — только про строки.
- Не ставим FK `part_id`: legacy-строки ссылаются на детали разных эпох (EAV `entities` до Phase 3, `directory_parts`/`erp_nomenclature` после); FK превратил бы бэкфилл в разбор истории справочника. Ссылка — отдельный этап после B4.
- Не трогаем снимки актов (`completeness_act`/`defect_act`, 24 строки, 3 МБ) и требования ремфонда — это версии печати, им положено быть слепками.
- Триггеры PG на `meta_json` не заводим: JSON-парсер в PL/pgSQL был бы вторым источником правил нормализации рядом с shared.

## Открытые вопросы владельцу

- Дубли листов (~350 двигателей с двумя+ живыми `engine_inventory`): бэкфилл берёт **самый свежий по `updated_at`** на двигатель, остальные оставляет без строк (клиент их и так не показывает — `getRepairChecklistForEngine` берёт первый по `updated_at desc`). Мягко удалить старые дубли — отдельным решением после E3.

# Порядок полей карточки, «Кто» по-русски, единая лента истории, ступени этапов

> **Статус: закрыто 01.10.2026.** Все четыре PR влиты: #1092 (порядок накладных),
> #1093 (служебные авторы), #1094 (единая лента истории), #1095 (ступени этапов).
> **Примечание 07.10.2026:** ступень `lastStage` («Последний этап»), заведённая в PR-D,
> снята решением владельца — она брала один последний этап и рядом с «Этапом на заводе»
> путала. См. `unified-repair-stages-2026-09.md`, постскриптум 07.10.2026.

Задача владельца 01.10.2026. Четыре независимых PR.

## PR-A. Порядок полей «Основного»: накладные вплотную к датам

- «Номер накладной (приход)» (`arrival_invoice`, `ENGINE_EXTRA_MAIN_FIELDS` order 51) — сразу под «Дата прихода» (`arrival_date`, defaultOrder 50). Формально соседствует уже; владелец видит иначе ⇒ причина в `persistFieldOrder`.
- «Номер накладной (отгрузка)» (`shipment_invoice`, order 71) — сразу после «Дата отгрузки» (`status_customer_sent`, defaultOrder 55). Порядок 71 явно ставит его далеко.
- **Корень:** `orderFieldsByDefs` (`ui/utils/fieldOrder.ts:21`) сортирует по `sortOrder` из `attribute_defs`, а `persistFieldOrder` (`EngineDetailsPage.tsx:1640`) перезаписывает их по порядку массива `desired` (с базой 10). Значит `f.order` из shared — мёртвое для полей, чей деф уже создан: побеждает записанный в БД порядок. Чинить: развести `defaultOrder` (для первогоensure) и фактический порядок (`desired`) в одном месте — собрать `desired` из одного списка на вкладке «Основное», где накладные стоят рядом с датами, и не полагаться на `order` в shared.

## PR-B. «Кто добавил» — служебные авторы по-русски

- Колонка «Кто» в `RepairStagesSection` и в ленте `EngineRepairHistoryPanel` показывает сырой логин. На проде есть `stages:backfill` (скрипт `backfillRepairStages.ts:232`, `actor.username`), плюс `stages:review-order`, `engine-inventory:fix-defect-stage-dates`, `engine-inventory:dedup-sheets`, `engine-inventory:backfill-lines`, `local`, `server`, `system`.
- Решение: общий словарь служебных авторов в shared (`serviceActors.ts`) — `serviceActorLabel(login)` → «перенос этапов (скрипт)», «проверка порядка этапов (скрипт)», «программа», и пусто для `local`/пустого (уже так делает `normalizeStageAuthor`). Применять в обеих колонках «Кто» + в паспорте (`EngineTimelinePanel.resolveWho`).
- Скрипты не переименовываем (записи в журнале уже на проде) — словарь закрывает и старые, и новые.

## PR-C. Единая лента истории ремонта

Сейчас три ленты (решение владельца: слить все три):
1. `RepairStagesSection` — «Этапы ремонта» (дата, этап, кто, правка даты, удаление);
2. лента `EngineRepairHistoryPanel` — ручные записи + стадии + переезды + строки этапов работ;
3. `EngineTimelinePanel` — «История ремонта (паспорт)», все операции `operations` (наряды, акты, склад, заявки).

План: один список из `operations` двигателя, новые сверху, колонки
`Дата события | Записано | Тип | Событие | Цех | Причина/Примечание | Кто | действие`.
- Источник строк — `buildEngineTimeline` (уже читает все `operations`) + этапы из `repairHistoryFromOperations`; объединить в shared-функцию `buildEngineHistoryFeed(rows)`, чтобы правило «одна лента» жило в домене, а не в компоненте.
- Дата создания записи (`updatedAt`/`createdAt`) показывается отдельной колонкой «Записано» — владелец прямо попросил видеть и реальную дату этапа, и дату ввода.
- Две кнопки добавления остаются: «Отметить этап» (из шаблона) и «Добавить запись» (ручная).
- Правка даты этапа и удаление — в строке этапа (как сейчас в `RepairStagesSection`), переносим в общую ленту.
- `RepairStagesSection`/`EngineTimelinePanel` поглощаются; `EngineRepairHistoryPanel` становится владельцем одной таблицы. Сторожа (`EngineRepairHistoryPanel.guard.test.ts`, `RepairStagesSection.guard.test.ts`, `EngineFactoryStagesReportPage.guard.test.ts` §«секция этапов внутри ленты») переписать на новое свойство: одна лента, этапы в ней, обе кнопки добавления.

## PR-D. Ступени этапов: две вместо четырёх + «Дата этапа»

Решение владельца: оставить «Есть этап» (любой этап, без привязки к дате) и «Последний этап» (по дате) + «Дата этапа». Убрать `historyAction`, `historyDate`, `sheetNode`, `sheetDate` (`shared/domain/engineListFacets.ts`).

- Новая ступень `hasStage`: значение `stage:<code>` из `engineFactoryStageOrder` — двигатель, у которого такой этап ЕСТЬ (любой, не только последний). Требует нового поля в строке списка: `stageCodes: string[]` (все коды этапов двигателя) — `EngineListItem` + `engineService.getEngineRepairHistoryMap` (собирает по `entries`).
- «Последний этап» — новая ступень `lastStage` по `lastStageCode`/`lastStageName` (то, что сегодня даёт `factoryStage`, но без частных веток вроде актов и утиля). Существующую `factoryStage` («Этап на заводе») оставить — это разрез отчёта, а не фильтр дублей.
- «Дата этапа» (`stageDate`) — `dateRange` по `lastStageAt`.
- Потребители: `EnginesPage` (`facetFields`, санитайзер), `EnginesReportPage` (`REPORT_HIDDEN_BY_DEFAULT` + колонки `sheetNode`/`historyAction`), `EngineFactoryStagesReportPage` (`FACET_IDS`), тесты `engineListFacets.test.ts`.

## Гейты (каждый PR)

`build shared` → `typecheck` (все три пакета) + `typecheck:test` → `lint` → `test` затронутых пакетов → CDP e2e-smoke (`verifier-electron`) для правок UI → CI зелёный перед мержем. Статус смоука — строкой в теле PR.
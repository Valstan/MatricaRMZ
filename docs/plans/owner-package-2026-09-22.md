# Пакет владельца 22.09.2026: поиск, дубли, заезды, дефектовка, бирки, срок ремонта, производительность

**Статус:** ACTIVE с 2026-09-22. Владелец выдал девять задач одним сообщением, план утверждён в тот же день. Отметки ✅ ставятся у пунктов по мере мержа PR.

## Context

Владелец 22.09 дал девять задач одним сообщением. Все они — UI/домен Electron-клиента и shared, без прод-скриптов и миграций PG (кроме одной опциональной, см. §5). Нитка G (E3-флип) не отменяется, но сдвигается: этот пакет идёт первым. Порядок ниже — от дешёвых и самостоятельных к длинным; каждый пункт — свой PR с handoff в том же PR (D-066). Разумно выкатывать релизами по 2–3 PR, а не одним.

Развилки решены владельцем (22.09):
- Точный поиск — списки + Ctrl+K; выпадающие пикеры остаются «похожими».
- Дубли деталей — жёсткий запрет; обход «повторный заезд / коллизия» у двигателей остаётся, но становится заметным и ведёт в существующую карточку.
- Флаг «у детали бывает свой номер» — на детали в комплекте марки, с переопределением в строке листа.
- Срок ремонта — дней из контракта, отсчёт от даты поступления на завод (не от аванса).

## Порядок PR

| # | Ветка | Тема | Размер |
|---|---|---|---|
| 1 ✅ | `fix/search-exact-default-everywhere` | точный поиск по умолчанию в Ctrl+K, 8 списках и остатках склада | S |
| 2 | `fix/short-contract-number-no-slash` | короткий номер только при слэше | XS |
| 3 | `fix/parts-duplicate-hard-block` | запрет дублей деталей, наглядный переход к существующей | S |
| 4 | `fix/repeat-arrival-labels` | пометки заездов в пикерах и логика карточки | M |
| 5 | `feat/contract-repair-days` | «дней на ремонт» в контракте, горящие от поступления, фильтры | M |
| 6 | `feat/defect-blank-two-columns` | бланк дефектовки: флаг «свой номер», два столбца на листе | M |
| 7 | `feat/engine-tags-print` | бирки на двигатель 6/4/2 на А4 | M |
| 8 | `perf/renderer-scanners-and-sync-refresh` | замер + дешёвые ускорения | M |
| 9 | `fix/entity-reference-focus-trap` | залипание фокуса | S |

---

## 1. ✅ Точный поиск по умолчанию везде (кроме пикеров)

**Что есть.** Режим `SearchMode = 'exact' | 'similar'` в `shared/src/domain/tieredSearch.ts:215`; кнопка `≈ Похожие` — `electron-app/src/renderer/src/ui/components/SearchModeToggle.tsx`, `searchModeOf(similar)` даёт `exact` при выключенной кнопке. Точный по умолчанию стоит только там, где страница явно прокидывает режим (6 страниц + `useListDeepFilter.ts:66`). Дефолт `'similar'` живёт в `electron-app/src/renderer/src/ui/utils/search.ts:58` (`matchesQueryInRecord`) и `:107-110` (`filterPreparedRecords`) — им пользуются без аргумента режима:
- Ctrl+K — `components/GlobalSearchOverlay.tsx:269,279,319`;
- 8 списков: `EngineBrandGroupsPage.tsx:67`, `ChangesPage.tsx:177`, `AdminPage.tsx:301`, `ToolPropertiesPage.tsx:76`, `StockInventoryPage.tsx:46`, `RepairFundAuditPage.tsx:62`, `WorkOrderTemplatesPage.tsx:59`, `EngineBrandDetailsPage.tsx:867`;
- остатки склада: `StockBalancesPage.tsx:30,62` → `erpService.ts:312` / backend `warehouseService.ts:2401` — `filterRowsTiered` с включённым fuzzy fallback, UI лишь показывает баннер.

**Что делать.**
- Перевернуть дефолт в `search.ts`: `mode: SearchMode = 'exact'` в обеих функциях. Пикеры (`SearchSelect`, `EntityReferenceField`, `useSuggestionDropdown`) идут через `rankLookupOptions`, а не через эти функции — их это не тронет; убедиться grep'ом, что ни один пикер не зовёт `matchesQueryInRecord`/`filterPreparedRecords`.
- Ctrl+K: состояние `similar` + кнопка `SearchModeToggle` в оверлее (рядом с полем), режим в `filterPreparedRecords(prep, q, mode)`; пустой результат — подсказка «Нажмите «≈ Похожие»» как в `EnginesPage.tsx:880`.
- 8 списков: `useListUiState` ключ `searchSimilar` + `SearchModeToggle` + `searchModeOf(...)` в вызов — по образцу `ContractsPage.tsx:484-489, 987`.
- Остатки склада: `filterRowsTiered(..., { fuzzyFallback: searchMode === 'similar' })` с клиента через параметр запроса до backend (`warehouseService.ts:2401`) — параметр `similar=1`; по умолчанию fuzzy выключен.
- Сторож `pages/SearchMode.guard.test.ts` расширить: каждая страница, вызывающая `matchesQueryInRecord`/`filterPreparedRecords`, обязана рендерить `<SearchModeToggle`; плюс тест дефолта `'exact'` в `search.ts`.

**Проверка.** `pnpm -F electron-app test` (сторож + существующие тесты search.ts), стенд: список «Группы марок» с опечаткой в раскладке → пусто, после «≈ Похожие» → найдено; Ctrl+K то же.

## 2. Короткий номер контракта только при слэше

`shared/src/domain/contract.ts:559-571` `shortContractSuffix`: сейчас берёт цифры части до первого `/` — если слэша нет, «часть до слэша» = весь номер, и «Письмо № 15 от 03.09.2026» даёт `*026`. Правило владельца: **нет слэша — короткий номер не формируется**, показываем номер как есть.
- `shortContractSuffix`: если в строке нет `/` → `''`. (Пустой результат уже даёт fallback на сырой номер в `shortContractSuffixLabel:606-613`.)
- `splitContractNumberAccent:582-599` — та же ветка: без слэша `{before: raw, accent: '', after: ''}` (без жирного).
- Добавить прямой unit-тест `shared/src/domain/contract.test.ts` (пока покрытие косвенное: `workSheetService.test.ts:266-294`, `engineFlowByCounterparty.test.ts:180-374`) — случаи: ГОЗ с `/` → `*239`; `125/2026` → `*125`; «Письмо № 15 от 03.09.2026» → `''`, label = сырой номер; пусто → `(без номера)`.
- Проверить, что существующие фикстуры не полагались на номер без слэша.

## 3. Дубли деталей — жёсткий запрет с переходом

**Что есть.** Двигатель по номеру блокируется локально (`engineService.ts:1269-1277`) и на сервере (`adminMasterdataService.ts:1258-1270`); обход — только флаги заезда/коллизии. Детали: `quickCreateEntity.ts:19-30` тихо возвращает существующую; `SearchSelect.tsx:205` блокирует inline-create; но `SimpleMasterdataDetailsPage.tsx:466,518,1267` показывает `DuplicateWarningDialog` с кнопкой **«Всё равно сохранить как новую»** (`components/DuplicateWarningDialog.tsx:137-174`) — это дыра. Серверный гейт `createDirectoryPart` (`warehouseService.ts:2126-2170`) — ключ `directoryPartDedupKey(name, code)` — блокирует только точное совпадение имя+артикул, а не «то же имя, другой артикул» и не «тот же сборочный номер».

**Что делать.**
- `DuplicateWarningDialog`: для severity «практически идентичное» (точное совпадение по норматайзеру имени **или** по сборочному номеру/артикулу) убрать «Всё равно сохранить как новую»; вместо неё — «Открыть существующую» (переход в карточку, текущая несохранённая форма закрывается) и «Отменить». Для «похоже» (fuzzy) кнопка сохранения остаётся — это не дубль.
- Серверный гейт: в `createDirectoryPart` и в апдейте имени/артикула — блок по `directoryPartIdentityKey` (`shared/src/domain/partsDedup.ts:31`) и отдельно по нормализованному `code` (артикул/сборочный номер) — ответ `duplicate part exists:<id>` уже есть, клиент по нему открывает карточку.
- Electron-путь создания детали в реплике (offline) — тот же ключ перед insert.
- Двигатели: ничего не ослаблять; диалог «Такой номер уже есть» (`EngineDetailsPage.tsx:208-240`) дополнить первой, самой крупной кнопкой «Открыть существующий двигатель →» (сейчас есть только «Открыть по рекламации», формулировка узкая). Баннер `EngineDuplicateHint` (`:92-243`) показывать сразу при вводе номера, не только на сохранении — проверить, что `findDuplicateCandidates` дёргается с debounce на каждое изменение.
- Диагностика два найденных дубля: разово прогнать существующий `engineDedupeService` dry-run (без apply), чтобы понять, старые ли это вливания или свежие (по `created_at`); результат — в тело PR.

**Проверка.** Тест диалога (нет кнопки «сохранить как новую» при exact), backend-тест гейта по имени и по артикулу, стенд: создать деталь с именем существующей → диалог → «Открыть существующую».

## 4. Повторный заезд — пометки в пикерах и логика карточки

**Что есть.** `shared/src/domain/repeatArrival.ts` `findArchivedArrivalIds` — архивным считается всё, кроме самого свежего, в группе с флагом. Список двигателей помечает `архивный заезд` / `🔁` (`EnginesPage.tsx:552-569`). **Карточка** (`EngineDetailsPage.tsx:1590-1620`) показывает бейдж «🔁 Повторный заезд» по флагу *этой* карточки и ссылку «прежний заезд →» по `previous_arrival_id` — то есть только с точки зрения флага, не группы. Отсюда нестыковка владельца: старая карточка ничего не знает, что она архивная, а флагованная описана как «повторный», хотя сама может быть уже не свежей (третий заезд). **Пикеры** двигателя (`ContractDetailsPage.tsx:312-318` `engineOptionLabel`, `WorkOrderDetailsPage.tsx:770-788`, любые `SearchSelect` с двигателями) — маркера нет вовсе.

**Что делать.**
- В shared добавить `arrivalRole(items, id): 'single' | 'current' | 'archived'` рядом с `findArchivedArrivalIds` и `arrivalGroup(items, id)` (все заезды того же номера, отсортированные по дате).
- В `EngineListItem` (`shared/src/ipc/types.ts:49-112`) — поля `arrivalRole`, `arrivalIndex`/`arrivalTotal` считать в `engineService.listEngines` один раз (там уже есть `isRepeatArrival`), чтобы пикеры не пересчитывали.
- Пикеры: единый хелпер `engineOptionLabel` в `renderer/src/ui/utils/engineOptionLabel.ts` — суффикс `· свежий заезд (2-й из 2)` / `· архивный заезд 2025` (год по `arrivalDate`), архивные — ниже в ранжировании и серым. Перевести на него `ContractDetailsPage`, `WorkOrderDetailsPage`, прочие места, где строится label двигателя (grep `internalNumberFull` в renderer).
- Карточка: блок заездов вместо текущего бейджа — «Заезд N из M» + список ссылок на все прочие заезды с датами; для архивного — жёлтый «Архивный заезд: есть более свежий → …»; для свежего — «Свежий заезд, архивных: M−1». Флаг `repeat_arrival_flag` остаётся служебным; «Коллизия номера» — без изменений.
- Отчёты: колонка/фасет «Заезд» (свежий/архивный) в `engineListFacets.ts` — по `arrivalRole`, чтобы отчёты умели разделять.

**Проверка.** Тесты `repeatArrival.test.ts` на `arrivalRole` (3 заезда, коллизия исключена); стенд с двумя карточками одного номера: пикер в контракте показывает пометки, карточки описывают себя правильно.

## 5. «Дней на ремонт» в контракте, горящие от поступления на завод

**Что есть.** `shared/src/domain/payments.ts:11-16` — `REPAIR_COUNTDOWN_DAYS = 90` зашито; `countdownStatus:198` считает от даты стартового аванса (`countdownStartDate` из `slotTotals`), гасится ремонтом (`isEngineRepairedForCountdown:514`); `burningEnginesCount:526` → колонка «Горящие двигатели» в `ContractsPage.tsx:688-718`; фасет `burning` уже есть в `contractListFacets.ts:136`. Контракт — EAV с заморозкой (AGENTS.md §EAV): новые поля кладутся в `contract_sections` JSON (`ContractPrimarySection`, `shared/src/domain/contract.ts`), в зеркало `erp_contracts.sections_json` они едут бесплатно, **миграция не нужна**.

**Что делать.**
- `ContractPrimarySection.repairDays?: number` + парсер/сериализатор; `effectiveRepairDays(sections) ?? 90`.
- Форма контракта `ContractDetailsPage.tsx:695-800` — `FormField` «Срок ремонта, дней» рядом с «Дата исполнения», сохранение через `contract_sections` (`:1761-1767`). Дополнения (`addons`) наследуют от primary.
- `countdownStatus(slot, todayIso, engineRepaired, opts: { startIso, days })`: точка отсчёта — `arrival_date` двигателя (атрибут `arrival_date`, есть в `EngineListItem.arrivalDate`), дни — из контракта. Пороги warning/danger пересчитать от `days` пропорционально (45/90 и 20 дней до конца → `days/2` и `min(20, days/4)`), константы оставить как дефолты. Аванс больше не участвует; `countdownStart` у платежа становится мёртвым флагом — снять из UI платежей, поле в JSON не трогать.
- Производные даты для бирки и фильтров: `repairDueDate = arrivalDate + repairDays` — хелпер в shared, отдать в `EngineListItem.repairDueDate` и `daysLeftForRepair`.
- Фасет «Горящие» в `engineListFacets.ts` (значения: горит / скоро / в сроке / без срока) → автоматически появляется в списке двигателей и в list-отчётах «Двигатели» и «Этапы производства» (они на фасетах, `EnginesReportPage`/`EngineFactoryStagesReportPage`). В `contracts_finance` (`reports.ts` ~1145) — фильтр `select` по горящим по образцу `dueState`.
- Пересчитать «Горящие двигатели» в `ContractsPage.tsx:434` на новую формулу.

**Проверка.** `payments.test.ts`: 60 дней/поступление → danger при 40 днях; без `arrival_date` → `none`; тесты фасета. Стенд: контракт с 30 днями, двигатель с датой поступления 40 дней назад — горит в списке контрактов и в фасете.

## 6. Бланк дефектовки: флаг «свой номер» и два столбца на листе

**Что есть.** Генератор — `electron-app/src/renderer/src/ui/utils/engineInventoryPrintHtml.ts` `buildInventoryDefectHtml` (~:322), 9 колонок, `blank` режим. Кнопка «Бланк дефектовки» — `RepairChecklistPanel.tsx:944 printBlankAct`. Флаги актов на детали в комплекте марки — `PartSpecBrandLink.inDefectAct` (`shared/src/domain/part.ts`, хранится в `brand_links_json`, без миграций); копируются в строку листа при resync с override (`RepairChecklistPanel.tsx:1620-1635`, поля `in_defect_act` / `in_defect_act_override`). Редактор марки — `EngineBrandDetailsPage.tsx:60-61, 262-263`.

**Что делать.**
- Флаг `hasOwnNumber` по образцу `inDefectAct`: `PartSpecBrandLink.hasOwnNumber?`, zod-схема part-spec, колонка-галочка в `EngineBrandDetailsPage` («Свой номер»), payload (`partSpecPayload`).
- Строка листа: `has_own_number?` + `has_own_number_override?` в `EngineInventoryRow` (`repairChecklist.ts:325-377`), `normalizeEngineInventoryRow`, `ENGINE_INVENTORY_KEYS`; копирование при resync рядом с `in_defect_act`; колонка-галочка в гриде дефектовки (`RepairChecklistPanel.tsx:2282-2324`, `INVENTORY_COL_WIDTHS:3683`). В реплику `erp_engine_inventory_lines` — **не добавлять колонку** (иначе миграция PG + SQLite + гейт #086); строка едет в `meta_json`, паритет-сторож `engineInventoryLinesReplica.guard.test.ts` сравнивает только известные поля — проверить, что неизвестный ключ не ломает `lineFromInventoryRow`/`inventoryRowFromLine` (там `raw` копируется целиком; убедиться тестом). Если сторож требует полного паритета — тогда миграция в обоих схемах, отдельным коммитом.
- Печать бланка (только `blank` режим, заполненный акт не трогаем): новый макет `buildInventoryDefectBlankHtml`: шапка бланка (марка, номер, заказчик, контракт); таблица в **два столбца** через CSS `columns: 2` на контейнере (или две таблицы по половине строк — надёжнее для `break-inside`), колонки: №, Наименование, Кол-во по конструкции, Наличие/ремонтопригодна/утиль (три клетки-чекбокса), «№ детали» — клетка рисуется только у строк с `has_own_number`, иначе ячейка объединена/пустая без рамки. Строки без флага — компактные (высота 14px), с флагом — выше, под рукописный номер. Подобрать шрифт 9–10px, `@page A4 margin 8mm`, цель — 100–120 строк на лист. Запасные строки `spareRows` — 4.
- Кнопка остаётся «Бланк дефектовки».

**Проверка.** Тест генератора: строка с флагом содержит клетку номера, без флага — нет; стенд: марка с 90 деталями → бланк на одном листе в предпросмотре печати.

## 7. Бирки на двигатель: 6 / 4 / 2 на А4

**Что есть.** QR-этикетки: `utils/qrLabels.ts` (`openLabelsPrint`, сетка `#sheet` A4 `grid-template-columns: repeat(N,1fr)`), `components/LabelPrintDialog.tsx`, кнопка «Печать этикеток» в `EnginesPage.tsx:822-829` строится из **отфильтрованного списка**, не из выделения. Выделение — `useListSelection` (`EnginesPage.tsx:512`, Shift+клик/стрелки, контекстное меню bulk `:748`); выражение выбранных строк уже есть на `:949`. Печатная инфраструктура — `utils/printPreview.ts` (`printSectionsDirect`, `openPrintPreview`).

**Что делать.**
- Новый `utils/engineTagPrint.ts`: `buildEngineTagsHtml(engines, { perSheet: 6|4|2 })`. Поля бирки: марка, номер двигателя (крупно), заказчик, номер контракта целиком (мелко, `ContractNumberText`-акцент не нужен), дата поступления на завод, дата начала ремонта (`statusDates.status_repair_started_date`), дата окончания по договору (`repairDueDate` из §5; если §5 ещё не выкачен — поступление + 90). Обозначения полей — мелкий шрифт, значения — крупный. Сетка: 6 → 2×3, 4 → 2×2, 2 → 1×2; ячейка `height: calc((297mm - margins)/rows)`, шрифт значений масштабируется по варианту (6: 16/28px, 4: 20/36px, 2: 28/52px), `break-inside: avoid`, каждая бирка с тонкой линией реза.
- Диалог `EngineTagPrintDialog.tsx`: радио 6/4/2 с живым предпросмотром A4 (`buildWorkOrderA4PreviewHtml` из `printPreview.ts`) и кнопкой «Печать». Источник — выделенные строки; если выделения нет — текущая карточка / отфильтрованный список с предупреждением о количестве.
- Точки входа: контекстное меню списка (bulk, «Бирки на выбранные (N)»), кнопка в тулбаре рядом с «Печать этикеток», кнопка «Бирка» в карточке двигателя.
- Настройку «последний выбранный вариант» держать в `useListUiState`.

**Проверка.** Тест `engineTagPrint.test.ts` (6 двигателей → 1 лист по 6, 2 листа по 4; поля в HTML); стенд: выделить 5 двигателей → предпросмотр 6/4/2.

## 8. Производительность: замер + дешёвые ускорения

**Что есть.** Инструментов замера нет вовсе. Два глобальных DOM-сканера смонтированы у корня (`App.tsx:908-909`): `useAdaptiveListTables.ts` — MutationObserver на `document.body` (subtree + characterData), на каждую мутацию пересчёт до 240 строк × колонок через `querySelectorAll('td,th')[col]` на ячейку дважды (`:96-105`, `:131-137`), запись CSS-переменных и `title` обратно в DOM; rAF-коалесинг (`:145-151`) при непрерывных мутациях срабатывает каждый кадр; скролл `VirtualTable` (measureElement `:111`) мутирует строки → цикл. `useAutoGrowInputs.ts` — `setInterval(1200)` (`:145`) обходит все `<input>` и пишет ширины, `getComputedStyle` ×3 на каждую клавишу (`:122-128`). Шторм обновлений после wake-синка v3.41: `App.tsx:1796` зовёт `refreshEngines()` на каждый `progress`, на `done` — дважды (`:1804` напрямую + через `liveDataService.ts:44` pulse → `useLiveDataRefresh` `App.tsx:4701`); `listEngines` (`engineService.ts:617-700`) — EAV-скан ~1600 двигателей с флагами инвентаря и историей. `refreshEngines` — обычная `async function` (`App.tsx:3371`), поэтому `useLiveDataRefresh.ts:58-74` переподписывается на каждый рендер App. `React.memo` в renderer один (`V3TabShell.tsx:31`).

**Что делать (один PR, первым коммитом — замер, чтобы снять базу до правок).**
- **A0 `utils/perfTrace.ts`** (+тест): `count(name)`, `measure(name, fn)`; включается при `import.meta.env.DEV` или `localStorage['matrica:perfTrace']==='1'` (чтобы включить на слабом ПК без пересборки); раз в 10 с `console.table` {name, calls, totalMs, maxMs}; `window.__matricaPerf.dump()`. Точки: `adaptiveTables.scheduled/recalc`, `autoGrow.syncAll/onInput`, `engines.refresh:<reason>`, `liveData.resubscribe`, `focus.stolen` (focusin на body сразу после mousedown по input).
- **A1 `useAdaptiveListTables.ts`**: кэш ячеек строки (`row.cells`) вместо `querySelectorAll` на ячейку; наблюдать childList/characterData только на активной панели `[data-pane-active="1"]`, на body — лишь `attributes:['data-pane-active']`; в колбэке игнорировать мутации вне `table.list-table`; trailing-debounce 150 мс вместо rAF-per-frame; во время скролла (200 мс после `scroll` capture passive) откладывать; не писать `setProperty`/`title`, если значение не изменилось.
- **A2 `useAutoGrowInputs.ts`**: снять интервал 1.2 с (оставить страховочный 10 с только при `document.hasFocus()`), пересчёт по событиям и мутациям с фильтром «есть ли input среди добавленных»; `readConfig()` кэшировать, инвалидировать по rootObserver; не переписывать одинаковую ширину; не трогать активный input, если ширина не изменилась.
- **A3 шторм `refreshEngines`**: убрать вызов из ветки `progress` (`App.tsx:1796`, включая `reloadEngineRef`); `scheduleEnginesRefresh(reason)` с коалесингом 3 с (leading + trailing) — вынести в `utils/coalesceCalls.ts` с тестом; звать из `done` и из live-pulse (убирает двойной вызов); `refreshEngines` в `useCallback([])`, чистые `sameEngineList/engineRowSignature` вынести из компонента. Guard-тест по образцу `*.guard.test.ts`: в блоке `evt.state === 'progress'` нет `refreshEngines(`.
- **A4 `useLiveDataRefresh.ts`**: `refresh` через ref, `safeRefresh` стабильный — подписка не пересоздаётся на каждый рендер; тест `does not resubscribe when refresh identity changes`.

**Проверка.** Тесты выше + существующие. На слабом ПК: включить флаг, открыть список двигателей, скроллить 10 с, печатать в чат 10 с, дождаться синка; цель — `adaptiveTables.recalc` ≤ 7 за 10 с при скролле, `autoGrow.syncAll` ≈ 0 в покое, `engines.refresh` ≤ 3 за синк, `liveData.resubscribe` 0 в покое. Снять базу до правок тем же способом (A0 отдельным коммитом).

## 9. Залипание фокуса

**Что есть.** `EntityReferenceField.tsx:89-119`: capture-`mousedown` на документе всегда, пока в поле нерешённый текст — `preventDefault + stopImmediatePropagation` на любой клик в окне, потом асинхронный диалог `pickChoice`; `resolvingRef` ставится поздно (`:160`), два клика подряд проходят оба; deps эффекта включают `options` (новая ссылка каждый рендер) — слушатель переустанавливается. Смежные capture-слушатели: `GlobalInputAssist.tsx:394-405,424-428,483` (M143), `useSuggestionDropdown.ts:172-181` (автозакрытие через 3 с), `useTabFocusSelectAll.ts:77,118-119`, `useListSelection.ts:98-135`.

**Что делать.**
- Слушатель вешать только когда `unresolved` (useMemo) истинно; в остальное время document-listener отсутствует.
- Чистая функция `classifyOutsideMousedown(target, {root, unresolved, resolving}) → 'ignore' | 'resolve-passthrough' | 'resolve-block'`: клик по другому `input/textarea/select/[contenteditable]` — **не** глотать (фокус уходит в поле, диалог всё равно открывается); по кнопкам/ссылкам — блок как раньше; внутри root/попапа — игнор.
- `resolvingRef.current = true` синхронно перед `resolveOnBlur`, сброс в `finally` со всеми ранними `return`; после Escape/закрытия диалога `unresolved` обязан стать `false`, иначе следующий клик снова блокируется.
- deps: `options` через ref, `latestPropsRef` — закрывает KNOWN GAP в `:114`.
- Тесты в `EntityReferenceField.test.ts`: ignores when nothing unresolved; ignores inside root/popup; passes through for another input; blocks for button; ignores while resolving. Guard: `addEventListener('mousedown'` под условием `unresolved`.
- Смежные (B2) — только если жалоба не закрылась, отдельными коммитами: `GlobalInputAssist` focusout по `relatedTarget` вместо `setTimeout(0)`, portal `preventDefault` только на самой подсказке; `useSuggestionDropdown` не автозакрывать, если `activeElement` — наш input; `useTabFocusSelectAll` `select()` только если фокус ещё в input.

**Проверка.** В карточке двигателя набрать несуществующую марку, кликнуть в соседнее поле — фокус в соседнем поле, диалог один раз; Escape → следующий клик работает. Клик по «Сохранить» с нерешённой ссылкой — блокируется как раньше. Метрика `focus.stolen` из §8 на слабом ПК — до/после.

## Верификация пакета

- Гейт на каждый PR: `corepack pnpm -r --workspace-concurrency=1 test` (при красном вне зоны — одиночный перепрогон, профиль PC79), `pnpm -r typecheck`, `lint`.
- Стенд `verifier-electron` (ABI-танец по профилю PC79) — для §1, §3, §4, §6, §7 CDP-смоуки с короткими опросами (M143: не ставить значения пикера через сеттер).
- Релиз: `/reliz` после 2–3 PR; §5 и §7 лучше в одном релизе (бирка использует дату окончания).
- Handoff: `docs/SESSION_HANDOFF.md` в каждом PR; нитка G переносится в «после пакета».

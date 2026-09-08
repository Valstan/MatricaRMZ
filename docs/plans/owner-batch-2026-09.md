# План: пакет владельца 08.09 — фильтры, карточка двигателя, шелл, слияние сотрудников

**Заведён:** 2026-09-08 · **Статус:** все восемь шагов написаны; на `main` — 1–7, шаг 8 в PR. Осталась прод-часть шага 8 (слияние по живым данным) — по отдельному OK владельца.

## Context

Владелец надиктовал 13 задач по Electron-клиенту. Разведка показала: почти всё ложится на существующие механизмы (фасеты `engineListFacets`, `tieredSearch`, `operations` + `EngineTimelinePanel`, `cardDrafts`, `chatUnreadTotal`, `UpdateRuntimeState`, `engineDedupeService` / `reassignUserReferences`). Два пункта — настоящие баги с найденной в коде причиной.

Порядок, утверждённый владельцем: **баги → фильтры/поиск/контракт → история ремонта → шелл → слияние сотрудников**. Флаг «военный/гражданский» — внутри JSON `contract_sections` (EAV-freeze не нарушаем, решение владельца). Слияние дублей сотрудника на проде — после релиза сервиса: dry-run → отчёт → OK владельца в том же ходе (гейт #025).

Каждый шаг — свой PR, `docs/SESSION_HANDOFF.md` едет в том же PR (D-066).

## Шаги

| # | Ветка | Задачи владельца | Статус |
|---|---|---|---|
| 1 | `fix/engine-act-scrap-reason-and-header-autofill` | причина утиля не сохранялась; шапка акта брала первую букву | ✅ сделан |
| 2 | `feat/engine-list-filters-panel` | фильтры двигателей под одну кнопку + акт дефектовки/статус/цех/даты | ✅ сделан |
| 3 | `feat/contract-list-filters-and-kind` | фильтры контрактов по всем полям карточки; военный/гражданский | ✅ сделан |
| 4 | `feat/list-search-exact-by-default` | точный поиск по умолчанию + кнопка «≈ Похожие» | ✅ сделан |
| 5 | `feat/engine-repair-history-editable` | история ремонта: автозапись + ручные строки + фильтрация по ней | ✅ сделан |
| 6 | `feat/shell-tabs-and-version` | порог вкладок 10; незакрываемые вкладки; подписи Верстака; колокольчик чата; **версия клиента в меню (Windows + Android)** | ✅ сделан |
| 7 | `feat/app-close-…` + `feat/update-progress-…` | закрытие с несохранёнными (#844) + прогресс обновления и «сейчас/позже» | ✅ сделан |
| 8 | `feat/employee-merge-service` | поиск дублей сотрудников и корректное слияние | ✅ сделан (прод-часть ждёт OK владельца) |

## PR 1 — баги акта (сделан)

**Причина утиля.** `RepairChecklistPanel.tsx` merge-коллбек `mergeBrandManagedRows` для `ENGINE_INVENTORY_STAGE` переносил из прежней строки `present/actual_qty/scrap_qty/replace_qty/stamped_number/in_*_act_override/replenishment_branch/__photos/__selected`, но **не `scrap_reason`**; у строки шаблона марки этого поля нет, поэтому brand-resync (раз на `syncKey` — то есть при каждом открытии карточки) пересобирал строку без причины и тут же сохранял. Фикс — перенос `scrap_reason` по образцу `stamped_number`.

**Шапка акта «берёт первую букву».** Усечения в коде нет. Настоящая причина: карточка двигателя шлёт пропсы на **каждое нажатие**, а признаком «поле ничьё» была пустота. При вводе номера в новом двигателе поле акта заполнялось первой же буквой, переставало быть пустым — и досыпка остатка (`2` → `2Ж` → `2Ж03`) блокировалась правилом «только заполняем пустое» (решение владельца 2026-08-01). Фикс — явное владение: `resolveHeaderAutofill` (`shared/src/domain/repairChecklist.ts`) + `headerAutofillRef` в панели. Пока в поле ровно то, что автоподстановка записала сама, значение догоняет карточку; правка или очистка руками отдаёт поле оператору навсегда; при перезагрузке листа владение забывается (чужое непустое поле не трогаем).

## PR 2 — фильтры списка двигателей

**Строка списка.** `EngineListItem` (`shared/src/ipc/types.ts`) и `listEngines` (`electron-app/src/main/services/engineService.ts`) получают: `defectDate` (attr `defect_date`), `hasDefectAct` (вторым флагом из `getEngineInventoryFlagsMap`), `workshopId`/`workshopName` (attr `workshop_id` + `directory_workshops`), даты статусов (`STATUS_DATE_CODES` уже читаются, но не проецируются), `engineNote`.

**Фасеты** (`shared/src/domain/engineListFacets.ts`): добавить `defectAct`, `workshop`, `status`, `engineNumber`, `internalNumber`. `presence` («на заводе/отгружен»), `completenessAct`, `reclamation` уже есть.

**Даты — новый вид фасета:** `kind: 'values' | 'dateRange'` + `dateOf(row)`; selection хранит `{from?, to?}` (одна дата = from=to). Дата-фасеты: приход, отгрузка, дефектовка, по одному на каждый статус. Общий компонент `components/DateRangeInput.tsx` выделить из дубликата в `EnginesPage`/`ContractsPage`.

**UI:** панель фасетов сворачивается под кнопку `Фильтры (n)`; состояние «раскрыто» — в list-UI-state. Дублирующие контролы тулбара (кнопка «Рекламационные», select «Акт компл.», два date-input прихода) убрать — их роли теперь у фасетов, миграция старого стейта по образцу `customerFilter → facets.customer`. Обновить `EnginesFacetFilter.guard.test.ts` (сторожит точные строки конвейера).

## PR 3 — фильтры контрактов + вид контракта

`ContractPrimarySection.kind?: 'military' | 'civil'` в `shared/src/domain/contract.ts` (внутри существующего JSON `contract_sections` — новых EAV-атрибутов не заводим), переключатель в первой вкладке карточки, зеркало `erp_contracts.sections_json` подхватывается триггером.

Обобщить `engineListFacets.ts` → generic `listFacets.ts` (`FacetDescriptor<Row>`), движковый файл остаётся тонким реэкспортом. Новый `contractListFacets.ts` над строкой `ContractsPage`, расширенной полями карточки: `kind`, контрагент, номера, ГОЗ-поля, `hasFiles`, марки из sections, исполненность, горящие; dateRange: заключение, исполнение, изменение. Компонент фасетов сделать generic `FacetFilter.tsx`.

## PR 4 — режимы поиска

`tieredSearch.ts` получает `mode: 'exact' | 'similar'` (дефолт `similar` — лукапы и `SearchSelect` не трогаем). `exact` — точное/префикс/compact-substring без subsequence, без RU↔EN раскладки, без Tier-3. Прокинуть через `ui/utils/search.ts` и `useListDeepFilter` (+ `search.cardContent`). В тулбаре списков — тумблер `≈ Похожие`, по умолчанию выключен; баннер «точных нет» заменить на подсказку про кнопку.

## PR 5 — история ремонта

Модель — строки `operations` (синк, права, аудит бесплатно; `EngineTimelinePanel` их уже читает). Новый `operationType: 'repair_history_entry'`, `meta_json`: `{kind:'repair_history', action, workshopId?, reason?, note?, extra?: [{label,value}]}`. Домен `shared/src/domain/engineRepairHistory.ts`: список действий, парсер, `repairHistoryFromOperations` — сливает автозаписи (смены статусов, `workshop_transfer`) и ручные строки. Действие не из списка — свободный текст; каталог подсказок = фиксированный список ∪ уже встречавшиеся значения.

UI вкладки: таблица с «Добавить запись» (дата, действие, цех, причина, примечание, «+ поле»), правка/удаление своих записей. Фильтры списка (продолжение PR 2): `lastHistoryAction`, `workshopId`, dateRange `historyDate` — чтобы видеть, сколько двигателей в каком цеху.

## PR 6 — шелл, Верстак, колокольчик

- `V3_WARN_TOTAL_TABS = 10` (`shared/src/domain/uiShellV2.ts`), `V3_MAX_TOTAL_TABS` поднять до 15; текст подсказки — про «проверьте, что всё сохранено».
- Незакрываемые вкладки: `canClose: !['menu','chat','ai_chat'].includes(kind)` (`App.tsx`); пункт меню «Чат» — не тумблер, а фокус.
- Подписи ярлыков Верстака: две строки видны целиком + троеточие (высота label-зоны `2 × labelLine`), `title` — полное имя.
- Колокольчик на вкладке Верстака: проп `chatUnread` из уже существующего `chatUnreadTotal`, число непрочитанных, CSS-анимация «дёрнуться» раз в 10 с. Guard-тест цепочки проп → JSX → CSS.

## PR 7 — закрытие программы и обновление

**Закрытие.** Существующий `closeCardSession({appClose:true})` видит только смонтированные панели — расширить реестр `registerCardCloseActions` до записи по `tabId`. Модал: список карточек, на каждую «Сохранить» / «Не сохранять» / «Перейти в карточку» (отменяет закрытие); отсчёт **30 с**, по истечении — черновики (`cardDrafts`, восстановление после логина уже есть) и выход.

**Обновление.** `setUpdateState` начинает слать `update:state` в главное окно; preload `update.onState`. Полоса прогресса — фон строки вкладок во всю ширину (лёгкий розовый, вкладки читаются). При `downloaded` — модал «Установить сейчас / Позже» (новый IPC `update:installNow`); немедленный `installNow` из `tick()` убрать, «Позже» оставляет установку следующему запуску.

## PR 8 — слияние сотрудников

Сервер `employeeDedupeService.ts` по образцу `engineDedupeService` + `userDeletionService.reassignUserReferences`: `analyzeEmployeeDuplicates()` (группы по нормализованному ФИО + fuzzy) и `mergeEmployees({survivorId, loserId, fieldOverrides?, dryRun})` в транзакции — EAV заполняется **только по пустым** полям основного, `role/access_enabled/login/password` основного не трогаются никогда; ссылки (link-атрибуты, `contract_sections`, `contract_payments`, crew/подписи в `operations.meta_json`) переводятся на основного; `reassignUserReferences` переносит чат, файлы, заметки, права, токены; `client_settings.lastUsername` переписывается **по логину**, а не по id; вторичный получает `merged_into`, доступ выключается, сущность гасится — всё через `writeSyncChanges`. Клиент: «Найти дубли» в списке сотрудников → диалог с выбором основного, сверкой полей и предпросмотром dry-run.

**Прод:** после релиза — dry-run по паре карточек одного человека → отчёт владельцу → OK в том же ходе → apply → проверка `users:parity`.

## Verification

- Гейты: build `shared`+`ledger` → `-r typecheck` + `electron-app typecheck:test` + `-r lint` → `-r --workspace-concurrency=1 test` (на `PC79` `boot.test.ts` добивается в одиночку).
- CDP-смоук (`verifier-electron`) на UI-шагах: акт (шапка целиком, причина утиля переживает переоткрытие), «Фильтры» с комбинацией цех+даты, военный/гражданский, exact vs похожие, 11 вкладок, закрытие с грязной карточкой, подписи Верстака, колокольчик, полоса обновления.

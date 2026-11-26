# 🟡 Управляющие кнопки вправо: остаток обхода — подвалы модалок (промт #141) 🗓 since:2026-11-25

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг и отложенное»

## Что это

Правило владельца от 24.11.2026 (промт КАРМАНА #118, PR #1998): **управляющие кнопки — влево**.
Жалоба: «на планшете справа некоторые кнопки уходят за край экрана, и приходится прокручивать
экран». #118 закрыл правило в списках и панелях списков (`PageToolbar`, `CardActionBar`,
`global.css`, `ListColumnChips`, `V3TabShell`) — но **не во всех карточках**.

Промт #141 (25.11.2026) — заказ про «Историю ремонта» в карточке двигателя: кнопки
«Добавить этап ремонта» / «Добавить запись» / «Перенести этапы…» стояли справа из-за
пустой распорки в шапке. Эта партия закрывает заказ **и** делает обход остальных мест,
где кнопки уводятся вправо через `marginLeft:'auto'`, `justifyContent:'flex-end'`, `flex: 1`
или пустую распорку.

**Где правило уже живёт (менять нельзя):** `PageToolbar` — ряд прижат влево, лишнее уходит
в меню «⋯» (`data-toolbar-overflow`); `CardActionBar` — все три группы слева, ряд переносится;
`global.css` — `.card-action-bar__group--right { justify-content: flex-start; flex: 0 0 auto }`.

## Что сделано в этой партии (промт #141)

| Файл | Что |
|---|---|
| `components/EngineHistoryFeedPanel.tsx` | Шапка ленты: распорка убрана, кнопки идут сразу за заголовком и счётчиком; порядок зафиксирован (запись → этап → перенос). Подвалы обеих форм («Отмена»/«Применить», «Отмена»/«Сохранить») — кнопки слева. Кнопки действий над записью (правка/снятие этапа, правка/снятие ручной записи) перенесены из безымянной колонки справа в **левую группу строки**; безымянной колонки справа больше нет. |
| `pages/EngineDetailsPage.tsx` | Ссылка-действие «Открыть» в подсказке по дублям номера — больше не прижата к правому краю (`marginLeft:'auto'` убран). |
| `components/TransferStagesDialog.tsx` | Подвал диалога переноса этапов: «Закрыть» — рядом с «Перенести этапы», не у края. |
| `components/AttachmentsModule.tsx` | Панель «Фото и документы» карточки двигателя: кнопки («Сохранить все», «Собрать в PDF», …) — сразу за счётчиком, а не у правого края. |
| `pages/PrintDocumentsPage.tsx`, `pages/PrintFormsPage.tsx`, `pages/WorkOrderTemplatesPage.tsx` | Тулбары страниц: кнопки создания — в общем ряду слева (было `marginLeft:'auto'` ⇒ уходили к правому краю окна). |
| `components/PrintDocumentPreviewDialog.tsx`, `components/PrintFormsDialog.tsx` | Шапки широких окон печати: «Закрыть» / «Печать / PDF» — рядом с названием. |
| `components/EngineHistoryFeedPanel.guard.test.ts` | Сторож правила: в шапке ленты нет распорки, порядок кнопок зафиксирован, кнопки действий строки — в левой ячейке, метки `data-repair-stage-form-open` / `data-repair-history-add` / `data-transfer-open` на месте. |

**Печать не затронута:** печать карточки двигателя и сводная печать по вкладкам строят свой
HTML из модели (`openPrintPreview` + `buildEngineReclamationPrintModel`), а не снимают DOM
панели ленты — правка раскладки на печать не влияет.

## Что сделано во второй партии обхода (промт #141)

Партия 2 (тулбары и панели) и партия 4 (шапки модалок) из инвентаря ниже **закрыты**.
Механизм один и тот же: пустая распорка (`<span|div style={{ flex: 1 }} />`) или
`marginLeft:'auto'` перед кнопкой уводили кнопку к правому краю. Распорка убрана — кнопка
встаёт сразу за тем, над чем действует, а ряд получает `flexWrap:'wrap'`, чтобы не
поместившееся переносилось, а не уезжало за край.

| Файл | Что |
|---|---|
| `components/RepairChecklistPanel.tsx` | Шапка панели чек-листа: «Свернуть»/«Экспорт»/«Печать» — сразу за заголовком панели. |
| `components/WorkOrderRoutePanel.tsx` | «Собрать маршрут»/«Убрать маршрут» — в ряду с кнопками этапов, не у правого края панели наряда. |
| `components/AttachmentsPanel.tsx` | Шапка «Вложения» и ряд «Выбрано файлов: N» — кнопки за заголовком/счётчиком. |
| `components/ChatPanel.tsx` | Шапка переписки («Сохранить все») и подвал окна комнаты («Отмена» — в группе с «Сохранить»). |
| `components/ClientOpsDialog.tsx` | «Закрыть» — в ряду с кнопками запуска. |
| `components/ProductionProgramPrintPreview.tsx` | «Печать»/«Закрыть» — рядом с названием окна печати. |
| `components/BulkStageAddDialog.tsx` | «Закрыть» — рядом с «Сохранить этап». |
| `components/AiAgentChat.tsx` | Правка и удаление вопроса — без `marginLeft:'auto'`. |
| `components/EmployeeDedupeDialog.tsx` | «Обновить» — рядом с заголовком окна дублей. |
| `components/ListPrintDialog.tsx` | «Закрыть» — рядом с названием окна печати. |
| `components/RepairStageTemplateDialog.tsx` | «Закрыть» — в группе с «Сохранить»/«Применить приоритеты». |
| `components/StageMapDialog.tsx` | «Закрыть» — рядом с «Карта этапов». |
| `components/WorkSheetTypeEditorDialog.tsx` | «Закрыть»/«Сохранить вид работ» — в одной группе. |
| `pages/EnginesPage.tsx` | Окно дублей: «Обновить»/«Закрыть» — за переключателем режима; «Открыть» у строки группы — за номером двигателя. |
| `pages/FileSearchPage.tsx` | «Отправить на печать» — за счётчиком отмеченных картинок. |
| `pages/ReportPresetPage.tsx` | «Сбросить все настройки» — за строкой статуса прогноза. |
| `pages/SupplyRequestDetailsPage.tsx` | «Добавить строку» и «Добавить поставку» — за заголовком, не у края. |
| `pages/TimesheetGridPage.tsx` | «Закрыть» окна подбора сотрудников — рядом с заголовком. |
| `pages/AdminPage.tsx` | «Обновить» (связи), «Сохранить» (карточка записи), «Расширенный режим» (разделы) и «Закрыть» в трёх окнах удаления — у правого края больше нет. |
| `App.tsx` | «Закрыть» окна аварийной ошибки — в группе с кнопками окна. |
| `components/buttonsLeft.guard.test.ts` | **Новый сторож на весь renderer:** сканирует все `.tsx` и падает, если где-то появится пустая распорка или `marginLeft:'auto'` перед кнопкой. Правило держится на всей программе, а не на списке файлов. |

### Почему сторож именно такой

Отдельные сторожи на каждый экран протухают: файл переехал — сторож замолчал, и кнопки
снова уехали вправо (грабля [M233](../gotchas/M233.md) — про то же самое со снимками).
Общий сторож проверяет **все** `.tsx` renderer разом: вернулась распорка в любом файле —
красный гейт с точным указанием места.

Проверен на подставном нарушении: временный файл с распоркой перед кнопкой роняет гейт
с указанием строки — то есть гейт не пустой.

### Что осталось (см. «Что осталось» ниже)

Только **партия 3** — подвалы модальных окон (`justifyContent:'flex-end'`): это решение
владельца, не агента (см. обоснование в партии 3). И **партия 5** — смоуки, которые гасят
оверлей приветствия неточным сравнением.

## Что осталось (инвентарь)

Статический скан renderer (`electron-app/src/renderer/src/ui/**/*.tsx`) ищет три признака —
пустая распорка перед кнопкой, `marginLeft:'auto'` рядом с кнопкой, `justifyContent:'flex-end'`
в ряду с кнопками. **Скан приблизительный** (он не знает про `visibility:hidden` и про
условный рендер) — это карта для обхода, а не приговор.

### Партия 2 — тулбары и панели (кнопка реально уезжает к краю окна) — ✅ ЗАКРЫТА

Закрыта во второй партии обхода (см. «Что сделано во второй партии обхода»): распорки
перед кнопками убраны, ряды переносятся. Список мест, которые были в инвентаре:

| Файл:строка (как было) | Что там |
|---|---|
| `components/RepairChecklistPanel.tsx:2928` | «Свернуть» / «Экспорт» прижаты вправо распоркой в шапке панели (карточка двигателя). Ряд переносится (`flexWrap:'wrap'`), сторож `RepairChecklistPanel.guard.test.ts` это описывает. |
| `components/WorkOrderRoutePanel.tsx:328` | Кнопки маршрута в панели наряда — у правого края. |
| `components/AttachmentsPanel.tsx:547, 664` | «Обновить» / «Выбрано файлов» + действия — у правого края. |
| `pages/EnginesPage.tsx:402, 475` | «Анализировать дубли» и «Открыть» у строки списка — у правого края. |
| `pages/FileSearchPage.tsx:798` | «Печать» отобранных файлов — у правого края. |
| `pages/ReportPresetPage.tsx:1510` | «Сбросить фильтры» — у правого края. |
| `pages/SupplyRequestDetailsPage.tsx:1730` | Кнопки печати заявки — у правого края. |
| `pages/TimesheetGridPage.tsx:864` | «Закрыть» подбора сотрудников — у правого края. |
| `components/ChatPanel.tsx:801`, `components/ClientOpsDialog.tsx:150`, `components/ProductionProgramPrintPreview.tsx:169`, `components/BulkStageAddDialog.tsx:427` | «Закрыть» / «Сохранить» отжаты вправо распоркой. |
| `components/AiAgentChat.tsx:415` | Кнопки правки сообщения чата — у правого края. |
| `pages/AdminPage.tsx:1296` | «Обновить» связи — у правого края. |

### Партия 3 — подвалы диалогов (`justifyContent:'flex-end'`) — ⏳ решение владельца

Пересчёт после второй партии обхода: **61 место в 42 файлах**. Было: `ConfirmContext.tsx` (210, 267, 337 — **общий диалог подтверждения,
задевает всю программу**), `App.tsx` (5614, 5845, 5941), `AdminPage.tsx` (1388, 1477, 1580),
`ContractDetailsPage.tsx` (3559, 3719, 3726, 3891, 3898, 3974), `ChildCardDialog.tsx:258`,
`DeletionIntentDialog.tsx` (124, 158), `DuplicateWarningDialog.tsx:199`,
`EmployeeDedupeDialog.tsx:264`, `EngineBulkIntakeDialog.tsx:1192`,
`EngineDismantlePreviewDialog.tsx:357`, `LabelPrintDialog.tsx:192`,
`ListExportButtons.tsx` (225, 302), `ListPrintDialog.tsx` (279, 460),
`MailComposeDialog.tsx:176`, `NomenclaturePropertyEditModal.tsx:183`,
`NomenclatureTemplateCompositionEditor.tsx:226`, `PrintDocumentFillDialog.tsx:229`,
`PrintTemplateEditorDialog.tsx:507`, `ProductionProgramAddEnginesDialog.tsx:456`,
`ProductionProgramAddEnginesByNumbersDialog.tsx:456`, `ProductionProgramStageDialog.tsx:358`,
`QuickCreateDialog.tsx:119`, `SendFileToColleagueDialog.tsx:112`,
`Stock1cImportDialog.tsx:674`, `WorkOrderKindPickerDialog.tsx:117`,
`WorkOrderTemplateEditorDialog.tsx:949`, `WorkshopTemplateDialog.tsx:615`,
`AssemblyReturnDialog.tsx:584`, `AuthPage.tsx:727`, `EmployeesPage.tsx:729`,
`EngineAssemblyBomDetailsPage.tsx` (882, 945), `EngineBrandDetailsPage.tsx:1301`,
`NomenclaturePage.tsx:1057`, `OrganizationPage.tsx` (545, 725),
`PpeVacationSchedulePage.tsx` (527, 598), `TimesheetGridPage.tsx` (910, 954),
`WorkOrderDetailsPage.tsx:3864`, `EnginesPage.tsx:483`.

**Это решение владельца, не агента.** Подвал модального окна живёт в окне своей ширины и за
правый край экрана не уезжает — «кнопки уходят за край» про него не говорит. Но правило
«управляющие кнопки влево» формально требует и его. Прецедент #118 подвалы модалок не трогал
(там менялись тулбары и панели) — поэтому решение оставлено владельцу.

### Партия 4 — шапки модалок («Закрыть» у правого края) — ✅ ЗАКРЫТА

Были: `App.tsx:5998`, `AdminPage.tsx` (1368, 1423, 1493, 1559), `EmployeeDedupeDialog.tsx:154`,
`ListPrintDialog.tsx:302`, `RepairStageTemplateDialog.tsx:346`, `StageMapDialog.tsx:48`,
`WorkSheetTypeEditorDialog.tsx:312`, `ClientOpsDialog.tsx:150`.

Закрыта во второй партии обхода: «Закрыть» и прочие кнопки шапки окна стоят рядом с
названием, а не у правого края. Прецедент — уже слитый PR #2048, где так же переехали
«Закрыть»/«Печать / PDF» в шапках окон печати.

### Партия 5 — смоуки: оверлей приветствия не гасится (16 скриптов)

Найдено при приёмке партии #141: смоук `cdp-history-buttons-left.mjs` отработал «зелёно»,
а **все три снимка показывали окно приветствия релиза**, а не карточку. Кнопка закрытия
называется «За работу! (Enter)», а скрипты искали её **точным** сравнением
`x.textContent.trim() === 'За работу!'` ⇒ оверлей оставался. DOM за оверлеем живой, поэтому
**замеры были верными** — расходились только картинки (грабля [M233](../gotchas/M233.md)).

Свой смоук #141 починен (гашение по началу подписи + проверка отсутствия
`.release-welcome-overlay` до снимка). Остальные 16 — список на владельца:

| Файл:строка | Как ищет |
|---|---|
| `scripts/cdp-bom-brand-group-bind.mjs:126`, `cdp-bom-card-simplified.mjs:96`, `cdp-bom-default-brand-render.mjs:116`, `cdp-nomenclature-parent-position.mjs:122` | `textContent.trim()===t` по списку `['За работу!','Позже']` |
| `scripts/cdp-employee-picker-rank.mjs:389`, `cdp-engine-act-number.mjs:102`, `cdp-engine-act-tabs.mjs:272`, `cdp-engine-conduct-buttons.mjs:422`, `cdp-manual-entry-undo.mjs:131`, `cdp-stage-returns-row.mjs:130` | `textContent.trim()===t` по списку `['За работу!','Позже','Отклонить','Закрыть']` |
| `scripts/cdp-children.mjs:95`, `cdp-contract-card-header.mjs:111`, `cdp-file-search.mjs:104`, `cdp-rail-defaults-tab-star.mjs:106`, `cdp-timesheet-and-icons.mjs:107`, `cdp-toolbar-panel.mjs:110` | `txt(x) === 'За работу!'` |
| `scripts/cdp-ppe-card-kind.mjs:313` | список `.includes(trim())` — то же самое |

**Лечение одно на все:** искать по началу подписи (`t.startsWith('За работу')`) и после
гашения **проверять, что оверлея нет** (`document.querySelector('.release-welcome-overlay')`),
иначе снимок снова покажет чужой экран. Уже сделанные правильно (образец) —
`cdp-print-forms.mjs:294`, `cdp-client-ops-launch.mjs:178`, `cdp-ppe-card-kind.mjs:179`
(там `startsWith` + отдельный список точных подписей).

## Как закрывать

1. **Партия 2** — ✅ закрыта (вторая партия обхода): распорки и `marginLeft:'auto'` перед
   кнопками убраны, ряды переносятся (`flexWrap:'wrap'`). Сторож на весь renderer стоит
   (`components/buttonsLeft.guard.test.ts`) — вернётся распорка, гейт краснеет.
2. **Партия 3** — только после решения владельца («подвалы модалок тоже влево?»). Если да —
   начинать с `ConfirmContext.tsx` (общий диалог): он меняется одним файлом и сразу виден
   везде. После правки обязателен прогон `ListChrome.guard.test.ts` и `SearchMode.guard.test.ts`.
3. **Партия 4** — ✅ закрыта (вторая партия обхода): кнопки шапки окна стоят рядом с названием.
4. **Приёмка каждой партии** — живой смоук на 1024 px: ни одна управляющая кнопка не уходит
   за правый край и ряд не требует горизонтальной прокрутки. Драйвер — `.claude/skills/verifier-electron/scripts/cdp-*.mjs`.
5. **Партия 5** (смоуки) — по списку выше: гашение оверлея по началу подписи + проверка, что
   оверлея нет, до снимка. Правка механическая, по одному файлу, приёмка — перегон любого
   смоука на стенде и **просмотр снимка глазами** (не только «PASS» в логе).

## Грабли

- **Скриншот — не ассерт, и его надо смотреть глазами.** Смоук #141 был «зелёным», а все три
  снимка показывали оверлей приветствия (кнопка «За работу! (Enter)» не находилась точным
  сравнением). Замеры из DOM при этом были верными — расходились только картинки.
  Грабля [M233](../gotchas/M233.md), список 16 скриптов — в партии 5.
- **Печать не трогать.** Печатные формы собирают свой HTML (`openPrintPreview`), правка
  раскладки панелей на печать не влияет — но и наоборот: печать «переедет», если полезть
  в модель печати.
- **Сторожи переписываются синхронно с кодом** (прецедент #118: `ListChrome.guard.test.ts`,
  `cardActionBarTablet.guard.test.ts`, `EnginesFacetFilter.guard.test.ts`). Правка панели без
  правки её сторожа = красный гейт.
- **Метки `data-*` не терять.** Смоуки находят кнопки по атрибутам
  (`data-repair-stage-form-open`, `data-repair-history-add`, `data-transfer-open`,
  `data-manual-edit`, `data-manual-remove`, `data-repair-stage-remove`).
- **Индекс `PENDING_FOLLOWUPS.md` у потолка** (50 КБ, запас ~200 байт) — новый пункт в индекс
  пишется короткой строкой, тест — файлом.
- **Живая приёмка кнопок строки ограничена:** заведённая ручная запись **не доезжает до ленты**
  (в `operations.list` строка есть, в панели «История ремонта» — нет). Воспроизводится и на
  **неизменённом** коде (A/B через `git stash`: штатный `cdp-manual-entry-undo.mjs` падает теми же
  6 шагами) ⇒ это **не регресс** промта #141, причина не исследована (вне границ задачи). Пока
  причина не найдена, проверить кнопки строки живьём нельзя — инвариант держит сторож по
  исходнику, а не смоук.

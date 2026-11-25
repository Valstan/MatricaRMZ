# 🟡 Управляющие кнопки вправо: обход renderer — остаток (промт #141) 🗓 since:2026-11-25

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

## Что осталось (инвентарь)

Статический скан renderer (`electron-app/src/renderer/src/ui/**/*.tsx`) ищет три признака —
пустая распорка перед кнопкой, `marginLeft:'auto'` рядом с кнопкой, `justifyContent:'flex-end'`
в ряду с кнопками. **Скан приблизительный** (он не знает про `visibility:hidden` и про
условный рендер) — это карта для обхода, а не приговор.

### Партия 2 — тулбары и панели (кнопка реально уезжает к краю окна)

| Файл:строка | Что там |
|---|---|
| `components/RepairChecklistPanel.tsx:2928` | «Свернуть» / «Экспорт» прижаты вправо распоркой в шапке панели (карточка двигателя). Ряд переносится (`flexWrap:'wrap'`), сторож `RepairChecklistPanel.guard.test.ts` это описывает. |
| `components/WorkOrderRoutePanel.tsx:328` | Кнопки маршрута в панели наряда — у правого края. |
| `components/AttachmentsPanel.tsx:547, 664` | «Обновить» / «Выбрано файлов» + действия — у правого края. |
| `pages/EnginesPage.tsx:402, 475` | «Анализировать дубли» и «Открыть» у строки списка — у правого края. |
| `pages/FileSearchPage.tsx:798` | «Печать» отобранных файлов — у правого края. |
| `pages/ReportPresetPage.tsx:1510` | «Сбросить фильтры» — у правого края. |
| `pages/SupplyRequestDetailsPage.tsx:1730` | Кнопки печати заявки — у правого края. |
| `pages/TimesheetGridPage.tsx:864` | «Закрыть» подбора сотрудников — у правого края. |
| `components/ChatPanel.tsx:1096`, `components/ClientOpsDialog.tsx:150`, `components/ProductionProgramPrintPreview.tsx:169`, `components/BulkStageAddDialog.tsx:427` | «Закрыть» / «Сохранить» отжаты вправо распоркой. |
| `components/AiAgentChat.tsx:415` | Кнопки правки сообщения чата — у правого края. |
| `pages/AdminPage.tsx:1296` | «Обновить» связи — у правого края. |

### Партия 3 — подвалы диалогов (`justifyContent:'flex-end'`)

~45 мест в 33 файлах: `ConfirmContext.tsx` (210, 267, 337 — **общий диалог подтверждения,
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

### Партия 4 — шапки модалок («Закрыть» у правого края)

`App.tsx:5998`, `AdminPage.tsx` (1368, 1423, 1493, 1559), `EmployeeDedupeDialog.tsx:154`,
`ListPrintDialog.tsx:302`, `RepairStageTemplateDialog.tsx:346`, `StageMapDialog.tsx:48`,
`WorkSheetTypeEditorDialog.tsx:312`, `ClientOpsDialog.tsx:150`.

## Как закрывать

1. **Партия 2** — по группам: снять распорку / `marginLeft:'auto'`, ряд оставить с переносом
   (`flexWrap:'wrap'`), ничего не помещающееся — в меню «⋯», как в `PageToolbar`.
2. **Партия 3** — только после решения владельца («подвалы модалок тоже влево?»). Если да —
   начинать с `ConfirmContext.tsx` (общий диалог): он меняется одним файлом и сразу виден
   везде. После правки обязателен прогон `ListChrome.guard.test.ts` и `SearchMode.guard.test.ts`.
3. **Партия 4** — по вкусу: «Закрыть» в шапке модалки читается как «заголовок окна».
4. **Приёмка каждой партии** — живой смоук на 1024 px: ни одна управляющая кнопка не уходит
   за правый край и ряд не требует горизонтальной прокрутки. Драйвер — `.claude/skills/verifier-electron/scripts/cdp-*.mjs`.

## Грабли

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

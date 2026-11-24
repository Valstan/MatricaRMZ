# Глобальные модули программы — реестр

> Куратируемый документ: **не автогенерируется**, держится ≤200 строк (план #125, п.1). Правило: **прежде чем писать новый модуль — сюда**.
> Живёт отдельно от карты приложения [`docs/CODEBASE_MAP.md`](CODEBASE_MAP.md): карта уже 52 КБ при обещании «≤2 экрана», и реестр в неё класть нельзя — в карте осталась короткая ссылка (план #128, п.1).
> Гейт актуальности — [`electron-app/src/main/services/globalModules.guard.test.ts`](../electron-app/src/main/services/globalModules.guard.test.ts): пути из реестра существуют, новые копии общих модулей запрещены.

## Правило

**Перед новым модулем — прочитать этот файл и проверить: нет ли готового.** Если готовый есть и работает на всю систему — доработать его, а не заводить второй. Если нет — новая строка в §«Реестр», одной строкой, иначе реестр протухнет и станет вредным.

Ритуал — три строки в плане (скилл `.claude/skills/global-lens/SKILL.md`, по образцу заводской линзы):

```
Глобальная линза: <модуль-кандидат> · дубль: нет | есть (<файлы>) · действие: доработать <модуль> | новый модуль нужен (почему)
```

## Реестр

Счёт мест — сколько файлов ссылаются на модуль (включая сам модуль); это признак «глобальности», а не точная статистика.

| Модуль (файл) | Что делает | Где применяется (файлов) | Как понять, что он глобален | Что НЕ в него входит |
|---|---|---|---|---|
| `shared/src/domain/listFacets.ts` | Движок ступеней фильтра (одна логика отсечения для всех списков) | 16 | Тонкие обёртки по сущностям зовут его, а не пишут своё; сторож `shared/src/domain/childListFacets.guard.test.ts` | Правила отбора данных конкретной сущности |
| `shared/src/domain/listBehavior.ts` | Правила поведения списков (выделение, перенос, лассо) + хуки `useListBehaviorSettings` / `useListReorder` / `useListLasso` | 24 + 19 + 18 | Одинаковое поведение во всех списках | Свои настройки конкретной страницы |
| `shared/src/domain/listGrouping.ts` | Группировка и разворачивание групп списка | 3 | Отчёт-список и список двигателей группируются одним правилом | Раскладка конкретной таблицы |
| `shared/src/domain/permissions.ts` | Коды прав: одна таблица кодов на клиент, сервер и синхронизацию | 74 | Любой гейт доступа ссылается на код из этого файла | Решения «кто главный» (это `shared/src/domain/ledgerAuthz.ts`) |
| `shared/src/domain/sectionAccess.ts` | Разделы, уровни доступа, зависимости разделов (предупреждение, а не запрет) | 14 | Кнопка раздела и её зависимости считаются одним правилом | Права на конкретную строку |
| `shared/src/domain/ledgerAuthz.ts` | Владение синхронизируемыми таблицами (серверный авторитет записи) | 33 | Любая новая синхронизируемая таблица обязана получить запись владения | UI-капы (это удобство, не защита) |
| `shared/src/domain/printTemplate.ts` | Модель печатного шаблона | 12 | Печать везде строится по одной модели шаблона | Виды форм (это `shared/src/domain/printForms.ts`) |
| `shared/src/domain/printForms.ts` | Реестр видов печатных форм | 16 | Форма выбирается по виду из одного списка | Содержимое конкретного бланка |
| `shared/src/domain/printSignatures.ts` | Общий слой подписей: слот, разбор, сборка | 6 | Подписи печатаются по одному правилу | Нарядная легаси-модель (это `shared/src/domain/workOrderSignatures.ts`) |
| `shared/src/domain/workOrderSignatures.ts` | Подписи наряда (легаси-блоки, свои id) | 5 | Наряд печатает подписи своими блоками | Общий слой подписей — он и есть |
| `shared/src/domain/cardExport.ts` | Экспорт карточки (общий формат выгрузки) | 6 | Выгрузка карточек одна на всех страницах | Экспорт списка (это `shared/src/domain/listExport.ts`) |
| `shared/src/domain/listExport.ts` | Экспорт списка (общий формат выгрузки) | 9 | Выгрузка списков одна на всех страницах | Экспорт карточки — это `shared/src/domain/cardExport.ts` |
| `shared/src/domain/objectCapabilities.ts` | **Каталог возможностей объекта**: какой тип объекта что умеет | 3 | Кнопка карточки берётся из каталога, а не из пропсов страницы | Обработчики и подписи (это `electron-app/src/renderer/src/ui/utils/objectActions.ts`) |
| `electron-app/src/renderer/src/ui/utils/objectActions.ts` | **Каталог действий по объекту**: шаблоны кнопок, «показывать только то, что умеет», подсказка «добавь объекту то, что есть у похожего» | 3 | Один общий тип объявления действия на списки и карточки | Права (надстройка над `deriveUiCaps`) |
| `electron-app/src/renderer/src/ui/utils/listContextActions.ts` | Меню списка собирается из объявления списка (`available`) | 17 | Недоступного пункта в меню нет ВООБЩЕ, а не «гаснет серым» | Состав действий конкретного списка |
| `electron-app/src/renderer/src/ui/utils/printPreview.ts` | Печать HTML-превью + `escapeHtml` | 38 | Любая печать идёт через превью; экранирование — здесь | Печатные бланки домена (у них своя модель) |
| `electron-app/src/renderer/src/ui/components/CardActionBar.tsx` | Панель действий карточки | 18 | Кнопки карточки — из каталога действий | Свои кнопки страницы мимо каталога (вне `extraActions*`) |
| `electron-app/src/renderer/src/ui/components/EntityCardShell.tsx` | Обвязка карточки (шапка, вкладки, прокрутка) | 11 | Любая карточка одета в одну обвязку | Содержимое полей карточки |
| `electron-app/src/renderer/src/ui/components/PageToolbar.tsx` | Панель инструментов страницы | 25 | Один вид панели на всех страницах | Кнопки, специфичные для страницы |
| `electron-app/src/renderer/src/ui/components/FacetFilter.tsx` | Виджет ступеней фильтра | 23 | Фильтр на всех списках выглядит одинаково | Правила отбора (это `shared/src/domain/listFacets.ts`) |
| `electron-app/src/renderer/src/ui/components/ListColumnChips.tsx` | Переключатель видимых колонок | 20 | Один вид переключателя на всех списках | Набор колонок конкретного списка |
| `electron-app/src/renderer/src/ui/shellV2/menuActions.ts` | Каталог глобальных действий программы (`ActionButtonId` / `ACTION_BUTTONS`) | 7 | Глобальные кнопки описаны один раз, пресеты собираются из каталога | Действия конкретной карточки |
| `electron-app/src/renderer/src/ui/shellV2/v2ButtonCatalog.ts` | Сборка глобальных кнопок под пресеты (в т. ч. планшетный) | 6 | Пресет = подмножество каталога | Права (считаются отдельно) |

**Что НЕ является глобальным модулем:** тонкая обёртка над общим движком (переиспользование — не дубль, см. §«Дубли»), правила конкретной страницы, зеркала клиент/сервер (осознанное дублирование, сервер авторитетен).

## Дубли

Аудит (план #125, часть 3; находки — #128). **Критерий дублирования:** дубль — это когда логика реализована ВТОРОЙ раз. Тонкая обёртка над общим движком дублем НЕ является.

| Модуль | Где дублируется | Чем различается | Решение | Риск | Кто решает |
|---|---|---|---|---|---|
| `shared/src/domain/repairStages.ts` (`currentDatedStage`), `shared/src/domain/engineFactoryStage.ts` (`engineFactoryStage`, `engineStateLabel`), `shared/src/domain/engineCurrentPass.ts` (`currentPassStageEntries`), `shared/src/domain/actStages.ts` (`actStageBest`), `shared/src/domain/productionProgram.ts` (`productionProgramEngineStage`), `shared/src/domain/payments.ts` (`isEngineDoneForCountdown`) + копии в `electron-app/src/main/services/engineService.ts` и `electron-app/src/main/services/repairStageService.ts` | «Где двигатель сейчас» — 6 реализаций в домене и 2 копии в main | Считают РАЗНОЕ: `currentPass` — текущий проход, `engineStateLabel` — абсолютное место; у `payments.ts` свой порог (`обкатка`), у `repairStageService.ts` — копия правила приоритета | Объединить — отдельной ниткой; сейчас зафиксировать и запретить новые копии (сторож) | Высокий: решение оператора на 2500+ двигателях; разъезд порогов = «двигатель на разных экранах стоит на разных этапах» | Владелец (объединение — не тихая правка) |
| `shared/src/domain/printSignatures.ts` vs `shared/src/domain/workOrderSignatures.ts` | Два слоя подписей | Одна семантика, разные модели и свои id блоков | Оставить нарядную как легаси; новые подписи — только через общий слой | Средний: печать хрупкая | Владелец |
| `shared/src/domain/workOrderSignatures.ts` | Две конвенции ФИО в одном файле: «И.О. Фамилия» (ГОСТ, наряд) и «Фамилия И.О.» (табель, ПП) | Порядок имени/инициалов | Оставить обе (это разные формы документов), но запретить третью | Низкий | Разработчик |
| `electron-app/src/renderer/src/ui/components/PrintSignatureBlockEditor.tsx` vs инлайновый блок в `electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx` | Два редактора подписей | Новый — общий компонент, старый — инлайн в карточке | Перевести наряд на общий компонент | Низкий | Разработчик |
| `escapeHtml` — `electron-app/src/renderer/src/ui/utils/printPreview.ts`, `electron-app/src/renderer/src/ui/utils/productionProgramPrintHtml.ts`, `electron-app/src/renderer/src/ui/utils/engineInventoryPrintHtml.ts`, `electron-app/src/renderer/src/ui/utils/markdownLite.ts`, `electron-app/src/renderer/src/ui/components/RepairChecklistPanel.tsx`, `electron-app/src/renderer/src/ui/pages/SupplyRequestDetailsPage.tsx`, `electron-app/src/main/services/fileService.ts` (там же `escapeHtmlMain` — не экранирует апостроф), `electron-app/src/main/services/toolsService.ts`, `web-admin/src/ui/EngineDetailsPage.tsx`, `web-admin/src/ui/components/RepairChecklistPanel.tsx` | 7 копий экранирования в клиенте + 3 в web-admin | `escapeHtmlMain` не экранирует апостроф — это не копия, а дыра | Общий модуль в `shared/src/`; сейчас — запрет новых копий (сторож) | Средний: печать — самая хрупкая зона | Владелец (правка печати — отдельной ниткой) |
| `electron-app/src/main/services/fileService.ts` | `photosPrint` и `photosPrintLocalPaths` — две почти одинаковые функции печати картинок | Разный источник путей (ids против локальных путей) | Общий шаг печати вынести; сейчас — не трогать (работает) | Средний | Разработчик |
| Четыре печатных HTML: `openPrintPreview`, `printSectionsDirect`, `buildWorkOrderA4PreviewHtml` в `electron-app/src/renderer/src/ui/utils/printPreview.ts` + `productionProgramPrintHtml.ts` | Разные печатные документы | Разные формы документов | Оставить (разные документы), экранирование — общее | Низкий | Разработчик |

### Зеркала — не дубликат

Клиент/серверное зеркало `findAllIncomingReferences` / `countExtendedIncomingReferences` — **осознанное дублирование**: сервер авторитетен, клиент — быстрый ответ. В список дубли не вносим.

## Каталог действий по объекту

Механизм «показывать только то, что умеет» в проекте **уже был** — для списков (`electron-app/src/renderer/src/ui/utils/listContextActions.ts`, поле `available`). Теперь он один на всю программу:

- **знание** — `shared/src/domain/objectCapabilities.ts`: какой тип объекта что умеет (`OBJECT_CAPABILITIES`), кто с кем родственен (`OBJECT_KINSHIP`);
- **сборка кнопок** — `electron-app/src/renderer/src/ui/utils/objectActions.ts`: `buildCardActions` даёт кнопку, только если объект умеет функцию, обработчик передан и есть право на правку;
- **панель** — `electron-app/src/renderer/src/ui/components/CardActionBar.tsx`: принимает `actions` и рисует кнопки ИЗ КАТАЛОГА (legacy-пропы — как раньше, для ещё не переведённых карточек);
- **объявление действия** — одно на списки и карточки: `ObjectActionDeclaration`; список объявляет `ListActionDeclaration` = тот же тип.

Обратная связь (совет при разработке, не подсказка в рантайме): `suggestCapabilityAdditions(kind)` → «объект X не умеет A, а похожий объект Y умеет — можно ли добавить Y?».

**Типы объектов и их возможности** (ключ домена ↔ реестр; гейт сверяет эту таблицу с `OBJECT_CAPABILITIES`, чтобы домен и реестр не разошлись):

| Тип объекта | Возможности |
|---|---|
| `engine` | copy_to_new · save · save_and_close · save_as_draft · reset · print · delete · close · attachments · payments |
| `work_order` | copy_to_new · save · save_and_close · save_as_draft · reset · print · delete · close · signatures · attachments |
| `work_sheet_row` | save · save_and_close · reset · delete · close |
| `counterparty` | copy_to_new · save · save_and_close · reset · print · delete · close · attachments |
| `contract` | copy_to_new · save · save_and_close · reset · print · delete · close · attachments · payments |
| `employee` | copy_to_new · save · save_and_close · reset · print · delete · close · attachments |
| `part` | copy_to_new · save · save_and_close · reset · delete · close |
| `tool` | copy_to_new · save · save_and_close · reset · delete · close |
| `nomenclature` | copy_to_new · save · save_and_close · reset · delete · close |
| `supply_request` | copy_to_new · save · save_and_close · reset · print · delete · close · attachments |
| `engine_brand` | copy_to_new · save · save_and_close · reset · delete · close |
| `stock_document` | save · save_and_close · reset · delete · close · print |
| `bom` | copy_to_new · save · save_and_close · reset · delete · close · print |

Первый переведённый объект: карточка этапа работ (`electron-app/src/renderer/src/ui/pages/WorkSheetDetailsPage.tsx`, тип `work_sheet_row`) — у нового этапа работ нет «удалить», и кнопки нет; печати у этого типа тоже нет (бланк одного этапа не печатают — сторож `WorkSheetsPage.guard.test.ts`).

## Правило пополнения

1. Новая глобальная способность — **одна строка** в §«Реестр» (файл, что делает, где применяется).
2. Найден дубль — строка в §«Дубли» (что, где, чем различается, решение, риск, кто решает).
3. Реестр пополняет тот, кто вводит модуль; **проверка — гейт** `electron-app/src/main/services/globalModules.guard.test.ts` (пути существуют, новые копии запрещены, реестр в бюджете ≤200 строк).
4. Реестр — **не пересказ кода**: 288 файлов в `shared/src/domain/` не перечисляются; здесь только то, что работает на ВСЮ систему.

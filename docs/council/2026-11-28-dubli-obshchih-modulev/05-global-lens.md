# Глобальная линза — дубли общих модулей: лестницы этапов и `escapeHtml`

> Первая линза совета (протокол §5): **есть ли уже готовый обработчик, который это делает?** Не «можно
> ли сделать», а «уже сделано ли» — и где.

## Вопрос 1. «Где двигатель сейчас» — что уже есть

**Готово и общее уже:**

| Что | Где | Что это |
|---|---|---|
| `repairStageRank(code)` | `shared/src/domain/repairStages.ts:220` | ранг этапа в лестнице — **единственный источник** порядка |
| `compareStageRecency(a, b)` | `shared/src/domain/repairStages.ts:252` | «что позже»: сначала календарный день, внутри дня — приоритет |
| `resolveStageCode` | `shared/src/domain/repairStages.ts:189` | код этапа → нормализованный код |
| `isServiceStageCode` | `shared/src/domain/repairStages.ts:62` | служебный этап (заведение карточки) — не этап ремонта |
| `currentDatedStage(rows)` | `shared/src/domain/repairStages.ts:511` | «текущее место»: последний этап **по времени** |

`engineFactoryStage.ts` уже импортирует этот примитив: `import { … isServiceStageCode,
repairStageRank … } from './repairStages.js'` (`shared/src/domain/engineFactoryStage.ts:3`).

**Вывод линзы:** ранжирование **не дублируется** — оно уже общее. Дублируются **верхние два слоя**:

1. **выбор лестницы** — какой «места» считать: `currentDatedStage` (последний по времени),
   `engineFactoryStage` (:215, объект места с повторами), `engineStateLabel` (:170, одна подпись),
   `currentPassStageEntries` (`engineCurrentPass.ts:57`, текущий проход),
   `actStageBest` (`actStages.ts:129`, лучший акт), `productionProgramEngineStage`
   (`productionProgram.ts:400`, место по производственной программе),
   `isEngineDoneForCountdown` (`payments.ts:704`, «готов ли для отсчёта»);
2. **пороги** — «обкатка = готов» написана дважды: `payments.ts:715`
   (`repairStageRank(code) >= repairStageRank('obkatka')`) и `engineFactoryStage.ts:201`
   (`stageRank >= repairStageRank('obkatka')` → «Готов, не отгружен»); рядом — порог «в ремонте»
   (`engineFactoryStage.ts:202`, `stageRank > repairStageRank('arrival')`).

**Действие линзы:** не «завести новый модуль лестниц», а **доработать существующее** — зафиксировать
контракт «что считает какая лестница» и вынести **пороги** в одно место рядом с `repairStageRank`.

## Вопрос 2. `escapeHtml` — что уже есть

**Готового общего модуля нет.** Искали в первом источнике (реестр глобальных модулей —
[`docs/GLOBAL_MODULES.md`](../../GLOBAL_MODULES.md)), затем в ките и в сервисах:

| Слой | Файлы | Сколько |
|---|---|---|
| `shared/src/**` | — | **0** (общего модуля нет) |
| renderer | `printPreview.ts:87`, `productionProgramPrintHtml.ts:81`, `engineInventoryPrintHtml.ts:52`, `markdownLite.ts:1`, `components/RepairChecklistPanel.tsx:91`, `pages/SupplyRequestDetailsPage.tsx:61` | 6 |
| main | `fileService.ts:68`, `toolsService.ts:55`, `photoPrint.ts:118` (`escapeHtmlMain`) | 3 |
| `web-admin` | `EngineDetailsPage.tsx:64`, `components/RepairChecklistPanel.tsx:22` | 2 |

**Важное различие, которое решает судьбу общего модуля:**

- `printPreview.ts:87` экранирует **и апостроф** (`:93` → `&#039;`);
- `photoPrint.ts:118` (`escapeHtmlMain`) апостроф **не** экранирует — и это **записано в коде**
  (`:116`: «Апостроф здесь НЕ экранируется (как и было): в атрибутах он не нужен»).

Значит общий модуль возможен только с **явным решением по апострофу** (экранировать везде или
оставить два режима), иначе он станет «модулем, который ведёт себя как в половине мест».

**Действие линзы:** **завести новый** общий модуль — но **в `shared/src/`**, а не в renderer: main
(`fileService.ts`, `toolsService.ts`, `photoPrint.ts`) и `web-admin` renderer-копии в общий слой
renderer не попадут, а `shared` импортируется и клиентом, и сервером.

## Итог линзы

| Кандидат | Дубль | Действие |
|---|---|---|
| Лестницы «где двигатель сейчас» | **ранжирование — нет** (общее); **пороги — да** (`payments.ts:715` ↔ `engineFactoryStage.ts:201`); **выбор лестницы — расходится** | **доработать существующее** (`repairStages.ts`) + зафиксировать контракт лестниц |
| `escapeHtml` | **да**, 11 копий (6 renderer + 3 main + 2 web-admin), общего в `shared/src` нет | **завести новый** в `shared/src/`, с решением по апострофу |
| Печать картинок (`photosPrint` ↔ `photosPrintLocalPaths`) | **нет** — обе уже зовут общий `printPhotos` (`photoPrint.ts`) | **не делать** (пункт PENDING устарел в этой части) |

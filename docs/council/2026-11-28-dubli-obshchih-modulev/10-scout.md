# Разведчик (`scout`) — дубли общих модулей: лестницы этапов и `escapeHtml`

> Ответ по контракту роли (устав — [`docs/advisors/scout/CHARTER.md`](../../advisors/scout/CHARTER.md)),
> ≤1 страницы. Границы разведки — **только названный участок**: лестницы «где двигатель сейчас» и
> `escapeHtml`. Весь проект не читался.

**Вердикт:** дубли в этом участке — **не те, что записаны в пункте PENDING**: копий лестниц в `main`
нет (там **импорты**), а настоящий дубль — **пороги «готов/в ремонте»**, написанные в двух файлах
домена; и `escapeHtml` — 11 копий, общего модуля нет. · **Уверенность:** высокая (файлы прочитаны,
строки названы)

## 1. Карта участка: «где двигатель сейчас»

| Файл | Символ | Что считает | Строки, где это видно |
|---|---|---|---|
| `shared/src/domain/repairStages.ts` | `repairStageRank` | **ранг этапа** — единственный порядок лестницы | `:220` |
| `shared/src/domain/repairStages.ts` | `compareStageRecency` | «что позже»: день → приоритет | `:252` |
| `shared/src/domain/repairStages.ts` | `currentDatedStage` | **текущее место**: последний этап по времени | `:511` |
| `shared/src/domain/engineFactoryStage.ts` | `engineFactoryStage` | место объектом `{key,label,rank,at,repeatPass}` + повторы | `:215` |
| `shared/src/domain/engineFactoryStage.ts` | `engineStateLabel` | **одна подпись состояния** (готов/в ремонте/принят/отгружен) | `:170` |
| `shared/src/domain/engineCurrentPass.ts` | `currentPassStageEntries` | **текущий проход** (не абсолютное место) | `:57` |
| `shared/src/domain/actStages.ts` | `actStageBest` | лучший этап **по акту** | `:129` |
| `shared/src/domain/productionProgram.ts` | `productionProgramEngineStage` | место **по производственной программе** | `:400` |
| `shared/src/domain/payments.ts` | `isEngineDoneForCountdown` | «**готов** ли для отсчёта» | `:704` |

**Связки (процессы):**

- Ранжирование **одно на всех**: `engineFactoryStage.ts:3` импортирует `repairStageRank`,
  `isServiceStageCode` из `repairStages.js`; `payments.ts` — тот же `repairStageRank`.
- **Порог «обкатка = готов» написан дважды:** `payments.ts:715` и `engineFactoryStage.ts:201`.
  Соседний порог «в ремонте» — `engineFactoryStage.ts:202` (`> repairStageRank('arrival')`).
- **Разные понятия, не записанные нигде:** `currentPassStageEntries` (текущий проход) и
  `engineStateLabel` (абсолютное место) — это **разные вопросы**; пункт PENDING это уже отмечает.

## 2. Главная находка: «2 копии в main» — неточность

Пункт PENDING и таблица «Дубли» реестра называют **копии лестниц в `main`**. Проверено:

- `electron-app/src/main/services/engineService.ts:29` — `import { … isEngineDoneForCountdown … }`;
- `electron-app/src/main/services/engineService.ts:33` — `import { … actStageBest … }`;
- `electron-app/src/main/services/repairStageService.ts:18` — `import { … actStageBest … }`.

То есть `main` **не переписывает** лестницы — он **вызывает доменные**. Поиск собственных
определений (`^(const|function|export function|export const) …stage…`) в `engineService.ts` — **пусто**.
Сторож `globalModules.guard.test.ts:71–72` называет эти файлы по **маркерам-использованиям**
(`actStageBest`, `loadEngineStageMarks`), а не по копиям кода.

**Следствие:** объединять «копии в main» нечего — там нет копий. Проблема в другом: **потребители
выбирают разные лестницы**, и пороги «готов/в ремонте» живут в двух файлах домена.

## 3. Карта участка: `escapeHtml`

**Определения (11):**

| Слой | Файл:строка | Апостроф |
|---|---|---|
| renderer | `electron-app/src/renderer/src/ui/utils/printPreview.ts:87` | **экранирует** (`:93` → `&#039;`) |
| renderer | `electron-app/src/renderer/src/ui/utils/productionProgramPrintHtml.ts:81` | не экранирует |
| renderer | `electron-app/src/renderer/src/ui/ui/utils/engineInventoryPrintHtml.ts:52` | не экранирует |
| renderer | `electron-app/src/renderer/src/ui/utils/markdownLite.ts:1` | не экранирует |
| renderer | `electron-app/src/renderer/src/ui/components/RepairChecklistPanel.tsx:91` | не экранирует |
| renderer | `electron-app/src/renderer/src/ui/pages/SupplyRequestDetailsPage.tsx:61` | не экранирует |
| main | `electron-app/src/main/services/fileService.ts:68` | не экранирует |
| main | `electron-app/src/main/services/toolsService.ts:55` | не экранирует |
| main | `electron-app/src/main/services/photoPrint.ts:118` (`escapeHtmlMain`) | **не экранирует — и это записано** (`:116`) |
| web-admin | `web-admin/src/ui/EngineDetailsPage.tsx:64` | не экранирует |
| web-admin | `web-admin/src/ui/components/RepairChecklistPanel.tsx:22` | не экранирует |

**Общего модуля нет:** поиск по `shared/src/**` — **0 совпадений**. `shared` импортируется и клиентом,
и сервером — значит общий модуль обязан лежать там, иначе `main` (`fileService.ts`, `toolsService.ts`,
`photoPrint.ts`) и `web-admin` в него не попадут.

## 4. Второй дубль, который в пункте PENDING числится открытым, а уже закрыт

`photosPrint` (`fileService.ts:1051`) и `photosPrintLocalPaths` (`fileService.ts:1075`): обе **уже**
вызывают общий шаг печати `printPhotos` (`photoPrint.ts`); различаются только **источником** файлов
(серверные вложения по id против локальных путей). Комментарий над `photosPrint:1047–1049` прямо
говорит: «Раньше здесь была вторая копия печати, из-за которой правка печати не доезжала до „Поиска по
файлам“» — **копия убрана**.

## 5. Дыры и расхождения

1. **Пороги «готов/в ремонте»** продублированы в домене (`payments.ts:715` ↔ `engineFactoryStage.ts:201–202`).
2. **Лестницы считают разное** — контракт не записан ни в одном файле.
3. **`escapeHtml` в 11 местах**, поведение по апострофу **разное** — общего решения нет.
4. **Пункт PENDING устарел в двух местах:** «2 копии в main» (копий нет) и «печать картинок» (уже общий шаг).

## 6. Что НЕ смотрено (покрытие)

- **Не читал** код печатных форм и `web-admin` глубже определения `escapeHtml` — там может быть свой
  HTML-слой со своими правилами экранирования (проверять отдельно, если дойдёт до правки).
- **Не смотрел** живой стенд (ответ по стенду — у Тестера).
- **Не считал** реальные данные (2500+ двигателей) — числа по разъезду лестниц не снимал.

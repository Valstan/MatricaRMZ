# Эффективщик (`efficiency`) — дубли общих модулей: лестницы этапов и `escapeHtml`

> Ответ по контракту роли (устав — [`docs/advisors/efficiency/CHARTER.md`](../../advisors/efficiency/CHARTER.md)),
> ≤1 страницы.

**Вердикт:** три решения из трёх форм — **доработать существующее** (лестницы: вынести пороги в
`repairStages.ts` и зафиксировать контракт) · **завести новый** (`escapeHtml` — в `shared/src/`) ·
**не делать** (объединять «копии в main» — копий там нет). · **Уверенность:** высокая

## Решения (строго одна форма на каждый вопрос)

| Кандидат | Решение | Цена | Риск |
|---|---|---|---|
| **Лестницы «где двигатель сейчас»** | **доработать существующее**: новый модуль НЕ нужен — пороги вынести в `shared/src/domain/repairStages.ts` (рядом с `repairStageRank`), а «лестницы» развести **контрактом в словах** | средняя: 1 модуль + правка 2 файлов + тесты на пороги | низкий: ранжирование не трогаем; меняется только источник констант |
| **`escapeHtml`** | **завести новый** общий модуль **в `shared/src/`** (`domain/htmlEscape.ts`): `escapeHtml` (экранирует апостроф) + `escapeHtmlAttribute`? — **нет**: один строгий вариант, апостроф экранируется везде | низкая-средняя: 11 мест → 1 импорт; main и web-admin подключаются тем же модулем | средний: **меняется вывод печатного HTML** — печать хрупкая; нужен прогон печатных форм |
| **«2 копии лестниц в main»** | **не делать** — копий нет (импорты: `engineService.ts:29,33`, `repairStageService.ts:18`) | нулевая | нулевой |
| **`photosPrint` ↔ `photosPrintLocalPaths`** | **не делать** — обе уже зовут общий `printPhotos` (`photoPrint.ts`) | нулевая | нулевой |

## Найденные дубли

| Дубль | Где реализовано (второй раз) | Чем отличается | Решение |
|---|---|---|---|
| **Порог «обкатка = готов»** | `shared/src/domain/payments.ts:715` и `shared/src/domain/engineFactoryStage.ts:201` | одинаково по сути, но **написаны отдельно**; правка одного места не тянет второй | вынести в одну функцию рядом с `repairStageRank` (`repairStages.ts:220`) |
| **Порог «в ремонте»** | `shared/src/domain/engineFactoryStage.ts:202` (`> repairStageRank('arrival')`) | нигде больше не задан | туда же |
| **`escapeHtml`** | 11 определений: renderer 6 (`printPreview.ts:87`, `productionProgramPrintHtml.ts:81`, `engineInventoryPrintHtml.ts:52`, `markdownLite.ts:1`, `RepairChecklistPanel.tsx:91`, `SupplyRequestDetailsPage.tsx:61`), main 3 (`fileService.ts:68`, `toolsService.ts:55`, `photoPrint.ts:118`), web-admin 2 (`EngineDetailsPage.tsx:64`, `RepairChecklistPanel.tsx:22`) | **разное поведение по апострофу**: `printPreview.ts:93` экранирует, остальные — нет; `photoPrint.ts:116` это зафиксировал как осознанное | один модуль в `shared/src/`, апостроф экранировать везде |
| **«Место двигателя» — выбор лестницы** | `currentDatedStage` (`repairStages.ts:511`), `engineFactoryStage` (`engineFactoryStage.ts:215`), `engineStateLabel` (`:170`), `currentPassStageEntries` (`engineCurrentPass.ts:57`), `actStageBest` (`actStages.ts:129`), `productionProgramEngineStage` (`productionProgram.ts:400`), `isEngineDoneForCountdown` (`payments.ts:704`) | считают **разное** (текущий проход / абсолютное место / лучший акт / место по ПП / готовность к отсчёту) — это **не копии**, это разные вопросы | **не сливать**; зафиксировать контракт (какая лестница что отвечает) и **запретить выбор лестницы мимо контракта** — это правится словами + одним экраном-тестом |

## Что объединять нельзя (и почему)

- **`currentPass` и абсолютное место** (`engineCurrentPass.ts:57` vs `engineFactoryStage.ts:215`) — разные
  вопросы по замыслу; слияние = потерять «повторный заход» как отдельное понятие.
- **Зеркала клиент/сервер** — дубли по построению, а не по недосмотру.
- **Тонкие обёртки над общим движком** — по критерию реестра дублем **не** являются
  ([`docs/GLOBAL_MODULES.md`](../../GLOBAL_MODULES.md) §«Дубли»).

## Цена и порядок

1. **Пороги + контракт лестниц** — отдельная нитка, ~1 день + тесты. Даёт пользу сразу: добавление
   этапа («Фаза», промт #116) перестаёт требовать правки нескольких мест.
2. **`escapeHtml` в `shared/src/`** — отдельная нитка, ~0.5 дня + **прогон печатных форм** (хрупкая зона):
   сначала перевод **main** (`fileService.ts`, `toolsService.ts`, `photoPrint.ts`), потом renderer, потом
   `web-admin`; каждый шаг — отдельный PR с проверкой печати.
3. **Сторож** `globalModules.guard.test.ts:38` — список копий `escapeHtml` **исчерпывающий**; после
   объединения он должен быть сокращён, иначе гейт будет охранять несуществующие копии.

## Чем проверяется за день

- Прогон `corepack pnpm -F @matricarmz/shared test` + `corepack pnpm -F @matricarmz/electron-app test` —
  зелёные после выноса порогов.
- Живой прогон печати: наряд + печатная форма + фото (`printPhotos`) — вывод HTML **не поехал**.
- `globalModules.guard.test.ts` — зелёный после сокращения списка копий.

## Что заставит передумать

- Если выяснится, что **разные лестницы считают одно и то же** (а не разное) — тогда это настоящие
  копии, и слияние обязательно. Фальсификатор: таблица «вопрос → лестница → ответ» с двумя
  одинаковыми ответами.
- Если экранирование апострофа в **печатном HTML** ломает подписи или выгрузку — тогда строгий общий
  модуль невозможен, и модуль должен иметь два режима (цена решения вырастет).

## Источники

`shared/src/domain/repairStages.ts:62,189,220,252,511` · `shared/src/domain/engineFactoryStage.ts:3,170,201,202,215` ·
`shared/src/domain/engineCurrentPass.ts:57` · `shared/src/domain/actStages.ts:129` ·
`shared/src/domain/productionProgram.ts:400` · `shared/src/domain/payments.ts:704,715` ·
`electron-app/src/main/services/engineService.ts:29,33` · `electron-app/src/main/services/repairStageService.ts:18` ·
`electron-app/src/main/services/photoPrint.ts:116,118` · `electron-app/src/main/services/fileService.ts:68,1051,1075` ·
`electron-app/src/main/services/toolsService.ts:55` · `electron-app/src/renderer/src/ui/utils/printPreview.ts:87,93` ·
`electron-app/src/main/services/globalModules.guard.test.ts:38,64–73` · `docs/GLOBAL_MODULES.md` §«Дубли»

## Моё слепое пятно в этой задаче

Я **не считал**, сколько раз на боевом парке (2500+ двигателей) эти лестницы дают разный ответ, и
**не смотрел** печатные формы на вывод HTML — «апостроф» в подписях бланков не проверял.

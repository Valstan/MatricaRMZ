# 🟡 Дубли общих модулей: объединить лестницы «где двигатель сейчас» и общий escapeHtml — решения владельца 🗓 since:2026-11-25

**Открыто:** объединение дубликатов общих модулей, найденных аудитом 25.11.2026 (план #125 часть 3, находки #128). Реестр и таблица решений — [`../GLOBAL_MODULES.md`](../GLOBAL_MODULES.md) §«Дубли». **Решение за владельцем:** объединение «где двигатель сейчас» — это решения оператора на 2500+ двигателях, печать — самая хрупкая зона, тихой правкой не обойтись.

## Что объединять (конкретно)

> **Уточнение 28.11.2026 по итогам совета** ([`docs/council/2026-11-28-dubli-obshchih-modulev/`](../council/2026-11-28-dubli-obshchih-modulev/)):
> пункты 1 и 3 в этой части **устарели или неточны** — см. «Что уже сделано» ниже. Суть пункта не
> изменилась: объединение — **за владельцем**, тихой правкой не обойтись.

1. **«Где двигатель сейчас» — 6 реализаций в домене + 2 копии в main:**
   `shared/src/domain/repairStages.ts` (`currentDatedStage`), `shared/src/domain/engineFactoryStage.ts` (`engineFactoryStage`, `engineStateLabel`), `shared/src/domain/engineCurrentPass.ts` (`currentPassStageEntries`), `shared/src/domain/actStages.ts` (`actStageBest`), `shared/src/domain/productionProgram.ts` (`productionProgramEngineStage`), `shared/src/domain/payments.ts` (`isEngineDoneForCountdown`), копии в `electron-app/src/main/services/engineService.ts` и `electron-app/src/main/services/repairStageService.ts`.
   Пороги разъезжаются; добавление этапа («Фаза», промт #116) требует правки нескольких лестниц сразу. **Отдельно зафиксировать контракт:** `currentPass` (текущий проход) и `engineStateLabel` (абсолютное место) считают разные вещи — сегодня это нигде не записано.
2. **`escapeHtml` — 7 копий в клиенте + 3 в `web-admin`:** `electron-app/src/renderer/src/ui/utils/printPreview.ts`, `electron-app/src/renderer/src/ui/utils/productionProgramPrintHtml.ts`, `electron-app/src/renderer/src/ui/utils/engineInventoryPrintHtml.ts`, `electron-app/src/renderer/src/ui/utils/markdownLite.ts`, `electron-app/src/renderer/src/ui/components/RepairChecklistPanel.tsx`, `electron-app/src/renderer/src/ui/pages/SupplyRequestDetailsPage.tsx`, `electron-app/src/main/services/fileService.ts` (там же `escapeHtmlMain` — **не экранирует апостроф**), `electron-app/src/main/services/toolsService.ts`, `web-admin/src/ui/EngineDetailsPage.tsx`, `web-admin/src/ui/components/RepairChecklistPanel.tsx`. Общий модуль — в `shared/src/`.
3. **Печать картинок:** `photosPrint` и `photosPrintLocalPaths` в `electron-app/src/main/services/fileService.ts` — почти одинаковые функции.

## Что уже сделано (25.11.2026)

- Сторож `electron-app/src/main/services/globalModules.guard.test.ts` **запрещает новые копии**: список разобранных копий исчерпывающий, любая новая — красный гейт.
- Реестр глобальных модулей [`../GLOBAL_MODULES.md`](../GLOBAL_MODULES.md) — по нему видно, что уже есть готовое.

## Что уже сделано (28.11.2026 — совет по промту КАРМАНА #198)

Разбор участка ([`10-scout.md`](../council/2026-11-28-dubli-obshchih-modulev/10-scout.md)) и решение
([`20-efficiency.md`](../council/2026-11-28-dubli-obshchih-modulev/20-efficiency.md),
[`99-verdict.md`](../council/2026-11-28-dubli-obshchih-modulev/99-verdict.md)):

- **«2 копии лестниц в main» — их нет.** `engineService.ts:29,33` и `repairStageService.ts:18` —
  **импорты** доменных функций, а не копии. Проблема в другом: **потребители выбирают разные
  лестницы**, и **порог «обкатка = готов» написан дважды** — `payments.ts:715` и
  `engineFactoryStage.ts:201` (рядом — порог «в ремонте» `engineFactoryStage.ts:202`).
- **Ранжирование уже общее**: `repairStageRank` (`repairStages.ts:220`) — новый модуль лестниц **не нужен**.
- **Пункт 3 (печать картинок) — уже закрыт**: `photosPrint` (`fileService.ts:1051`) и
  `photosPrintLocalPaths` (`:1075`) обе зовут общий шаг `printPhotos` (`photoPrint.ts`).
- **`escapeHtml` — 11 копий**, общего в `shared/src` нет; поведение по апострофу **разное**
  (`printPreview.ts:93` экранирует, `photoPrint.ts:116` — сознательно нет).
- **Расхождение воспроизведено на стенде**: 20 из 59 движков дают **разный** ответ в двух живых
  считываниях места («по времени» и «подпись состояния») — [`50-tester.md`](../council/2026-11-28-dubli-obshchih-modulev/50-tester.md).

## Решение за владельцем

Совет **сузил** задачу и выдал варианты с ценой:

1. **Объединять ли лестницы в общем виде** — совет: **не сливать** (семь функций считают разное;
   цена — регресс на 2500+ двигателях). Дешевле и безопаснее — **вынести пороги в один источник**
   рядом с `repairStageRank` и **зафиксировать контракт лестниц** в словах.
2. **Общий `escapeHtml` — где живёт.** Совет: **`shared/src/`** (main и `web-admin` в renderer-слой
   не попадут). Один строгий вариант, апостроф экранируется везде. Порядок: main → renderer →
   `web-admin`, каждый шаг отдельным PR **с прогоном печати** (печать — хрупкая зона).
3. **Трогать ли печать в этом цикле.** Совет: сначала пороги и контракт (дёшево, безопасно), печать —
   следующей ниткой; решение владельца нужно **до** начала печати.
4. **Вопрос владельцу в его словах** (из идей шута, переведено в применимое): на каком экране
   двигатель должен называться иначе, чем на другом? — от ответа зависит объём работы.

Связанное: подписи печатных форм и перенос наряда на общий компонент — пункт `pending/print-signature-slots-acceptance.md`.

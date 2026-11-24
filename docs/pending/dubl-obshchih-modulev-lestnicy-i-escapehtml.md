# 🟡 Дубли общих модулей: объединить лестницы «где двигатель сейчас» и общий escapeHtml — решения владельца 🗓 since:2026-11-25

**Открыто:** объединение дубликатов общих модулей, найденных аудитом 25.11.2026 (план #125 часть 3, находки #128). Реестр и таблица решений — [`../GLOBAL_MODULES.md`](../GLOBAL_MODULES.md) §«Дубли». **Решение за владельцем:** объединение «где двигатель сейчас» — это решения оператора на 2500+ двигателях, печать — самая хрупкая зона, тихой правкой не обойтись.

## Что объединять (конкретно)

1. **«Где двигатель сейчас» — 6 реализаций в домене + 2 копии в main:**
   `shared/src/domain/repairStages.ts` (`currentDatedStage`), `shared/src/domain/engineFactoryStage.ts` (`engineFactoryStage`, `engineStateLabel`), `shared/src/domain/engineCurrentPass.ts` (`currentPassStageEntries`), `shared/src/domain/actStages.ts` (`actStageBest`), `shared/src/domain/productionProgram.ts` (`productionProgramEngineStage`), `shared/src/domain/payments.ts` (`isEngineDoneForCountdown`), копии в `electron-app/src/main/services/engineService.ts` и `electron-app/src/main/services/repairStageService.ts`.
   Пороги разъезжаются; добавление этапа («Фаза», промт #116) требует правки нескольких лестниц сразу. **Отдельно зафиксировать контракт:** `currentPass` (текущий проход) и `engineStateLabel` (абсолютное место) считают разные вещи — сегодня это нигде не записано.
2. **`escapeHtml` — 7 копий в клиенте + 3 в `web-admin`:** `electron-app/src/renderer/src/ui/utils/printPreview.ts`, `electron-app/src/renderer/src/ui/utils/productionProgramPrintHtml.ts`, `electron-app/src/renderer/src/ui/utils/engineInventoryPrintHtml.ts`, `electron-app/src/renderer/src/ui/utils/markdownLite.ts`, `electron-app/src/renderer/src/ui/components/RepairChecklistPanel.tsx`, `electron-app/src/renderer/src/ui/pages/SupplyRequestDetailsPage.tsx`, `electron-app/src/main/services/fileService.ts` (там же `escapeHtmlMain` — **не экранирует апостроф**), `electron-app/src/main/services/toolsService.ts`, `web-admin/src/ui/EngineDetailsPage.tsx`, `web-admin/src/ui/components/RepairChecklistPanel.tsx`. Общий модуль — в `shared/src/`.
3. **Печать картинок:** `photosPrint` и `photosPrintLocalPaths` в `electron-app/src/main/services/fileService.ts` — почти одинаковые функции.

## Что уже сделано (25.11.2026)

- Сторож `electron-app/src/main/services/globalModules.guard.test.ts` **запрещает новые копии**: список разобранных копий исчерпывающий, любая новая — красный гейт.
- Реестр глобальных модулей [`../GLOBAL_MODULES.md`](../GLOBAL_MODULES.md) — по нему видно, что уже есть готовое.

## Решение за владельцем

- Объединять ли «где двигатель сейчас» сейчас, отдельной ниткой или после; кто решает — владелец (запись в §«Дубли» реестра: «кто решает»).
- Общий `escapeHtml` — в `shared/src/` или в слое renderer (там, где печать).

Связанное: подписи печатных форм и перенос наряда на общий компонент — пункт `pending/print-signature-slots-acceptance.md`.

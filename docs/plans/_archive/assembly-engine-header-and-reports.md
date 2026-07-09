# План: наряд-сборка → двигатель + отчёты по двигателям + универсальные фильтры

Запрос владельца (2026-07-09), 4 связанные доработки. Делаем **двумя PR**.

## PR1 — наряд↔двигатель (фичи 1+2) — ветка `feat/assembly-engine-header-and-auto-status`

**Фича 1 — номер двигателя в шапке сборочного наряда.**
- `shared/src/domain/workOrder.ts`: поле `WorkOrderPayload.assemblyEngineId?: string | null` + нормализация в `normalizeWorkOrderPayloadV3Fields` + хелпер `resolveAssemblyEngineId(payload)` (fallback на `primaryAssemblyEngineId`).
- `WorkOrderDetailsPage.tsx`: header-`SearchSelect` «Двигатель» (только Assembly) в полосе реквизитов; выбор проставляет `engineId/engineNumber/engineBrandId/engineBrandName` во все `freeWorks` (+ legacy `workGroups.lines`); новые строки (`addFreeWorkLine`) наследуют; per-row колонки «№ двигателя»/«Марка» скрыты для Assembly. Предупреждение о незаданном двигателе — по header-полю.

**Фича 2 — авто-статусы двигателя (только вперёд, без авто-отката).**
- `shared/src/domain/contract.ts`: `applyStatusFlagChange(flags, code, next)` (взаимоисключение, единый источник для карточки и авто-перехода) + `STATUS_ADVANCE_RANK`.
- `electron-app/src/main/services/engineService.ts`: `advanceEngineStatusForWorkOrder(db, engineId, target, dateMs, actor)` с guard'ом «только вперёд».
- IPC `engine:advanceStatus` (`enginesOpsAudit.ts`) + bridge `engines.advanceStatus` (`preload/index.ts`, `shared/src/ipc/types.ts`).
- `WorkOrderDetailsPage.tsx`: кнопка «Выдать в работу» обобщена на Assembly → `status_repair_started`; onChange даты выполнения → `status_repaired`. «Отозвать»/очистка даты статус НЕ откатывают.
- `EngineDetailsPage.tsx`: `applyStatusCheckboxChange` переведён на общий `applyStatusFlagChange`.

## PR2 — отчёты (фичи 3+4) — ✅ реализовано

**Фича 3 — обогатить `engines_list`** (`shared/src/domain/reports.ts` + `reportPresetService.ts:buildEnginesListReport`): добавить `date_range` «начало ремонта» (`status_repair_started_date`) и «окончание ремонта» (`status_repaired_date`) + колонки. Диапазоны создание/приход/отгрузка уже есть.

**Фича 4 — универсальные «сброс» + «отключить» у каждого фильтра** (`ReportPresetPage.tsx` + `reportUtils.ts`; `reportPresetService.ts:readPeriod`): client-state `disabledFiltersByPreset`, две кнопки в `renderFilterControl` (+ bespoke `renderAssemblyForecastFilters`), исключение ключей отключённых фильтров из запроса; `readPeriod` — при отсутствии `endMs` возвращать `MAX_SAFE_INTEGER` вместо `now`.

## Решения владельца (2026-07-09)
- Триггер «Начат ремонт» — по кнопке «Выдать в работу» сборочного наряда.
- Статусы двигаются только вперёд, без авто-отката.
- Отчёт №3 — обогащаем существующий `engines_list`, не новый.

## Verification
Гейты: build shared → typecheck (per-package) + lint → backend tests → CDP e2e-smoke (verifier-electron, PC40). Сценарии — см. approved plan.

# Отчёт «Наряды»: «Отгружен» + сводка статусов; отказ от «тихого» сохранения; отчёты по кнопке

## Context

Запросы владельца (2026-07-13):
1. В отчёте «Наряды» — колонка **«Отгружен»** (дата отгрузки двигателя заказчику, прочерк если нет) + сортировка по ней; в подвале — **сводка**: всего выписано, выполнено, выполнено с просрочкой, просрочено, отозвано, отгружено (отправлено заказчику), принято заказчиком; **опциональная разбивка сводки по маркам двигателей** (чекбокс, по умолчанию выкл).
2. Убрать «тихое» сохранение: карточка «Марка двигателя» — список деталей сейчас пишет в БД сразу (галочки актов, кол-во, добавление/удаление) → перевести на отложенное сохранение по кнопкам «Сохранить»/«Сохранить и выйти» + вопрос при закрытии (механизм уже есть). Плюс админ-редакторы (onBlur-сохранение в AdminPage).
3. Отчёты не формировать автоматически — только по кнопке «Сформировать отчёт».

Решения владельца: список деталей — полностью по кнопке; объём — включая админку; «Отгружен» — дата.

## Два PR

- **PR-1 «Отчёты» (нитки D → A)** — сначала убрать авто-билд, затем колонка+сводка.
- **PR-2 «Сохранение» (нитки B → C)** — карточка марки (рискованная), затем админка (механическая).

---

## PR-1, нитка D — отчёты только по кнопке

`electron-app/src/renderer/src/ui/pages/ReportPresetPage.tsx`:
- Удалить auto-build `useEffect` (debounce 400ms, :328-339) и связанный `autoBuildRef`.
- В `buildPreview()` фиксировать `setCachedFiltersKey(filtersKey)` для всех пресетов; сброс кэша при смене пресета (:265).
- Кнопка **«Сформировать отчёт»** + бейдж «Фильтры изменились — переформируйте» — по готовому образцу `assembly_forecast_7d` (:1050-1063); заменить текст «формируется автоматически» (:1069-1079); первый заход — пустое состояние с подсказкой (:1094-1099).
- Экспорт/печать/PDF/CSV/1С строят в main по `requestFilters` — не трогаем.

## PR-1, нитка A — «Отгружен» + сводка статусов

**Дата отгрузки:** готовый резолвер `resolveEngineShippingState(attrs)` (`electron-app/src/main/services/reportEngineShippingState.ts`) — приоритет `status_customer_sent_date` → `status_customer_accepted_date` → legacy `shipping_date`. Флаги: `attrs.status_customer_sent` / `status_customer_accepted` (labels в `shared/src/domain/contract.ts` STATUS_LABELS).

**Анти-дублирование:** сводку считает main ОДИН раз, все три рендера (on-screen, предпросмотр, печать/PDF) переиспользуют shared-функции.

1. `shared/src/domain/workOrdersReport.ts`:
   - Колонка `{ key: 'shippedDate', label: 'Отгружен', kind: 'date' }` (после completedDate; `fmtCell` уже даёт «—» для null).
   - `WorkOrdersReportSortBy` + `'shippedDate'`; ветка в `sortWorkOrdersReportRows`.
   - Новые типы/функции: `WorkOrdersStatusCounts` {total, done, doneLate, overdue, withdrawn, shipped, accepted}, `WorkOrdersStatusSummary` {counts, byBrand?}, `computeWorkOrdersStatusSummary(rows, {byBrand})`, `formatWorkOrdersStatusCountsLine()`.
   - `WorkOrdersReportRenderArgs.statusSummary?` + рендер блока сводки (и таблицы byBrand) в `renderWorkOrdersReportInner`.
2. `shared/src/domain/reports.ts`: sortBy-опция «По дате отгрузки»; checkbox-фильтр `summaryByBrand` (default false); поле `workOrdersStatusSummary` в preview-типе (:153-159).
3. `electron-app/src/main/services/reportPresetService.ts::buildWorkOrdersReport`: после резолва attrs двигателя (:1775) — `resolveEngineShippingState` + флаги; в row служебные `shippedDate`/`customerSent`/`customerAccepted` (не в columns-суперсет, как statusCode); `computeWorkOrdersStatusSummary` → в результат preview; проброс в печать/PDF (:4770-4785).
4. Renderer: `reportUtils.ts` (:430-452) и `ReportPresetPage.tsx` (:1153) — только проброс/вывод готовой summary.

## PR-2, нитка B — карточка марки: отложенный список деталей

`electron-app/src/renderer/src/ui/pages/EngineBrandDetailsPage.tsx`:
- `committedPartsRef` — снапшот из `loadBrandParts`; `brandParts` становится драфтом.
- Перевести в state+dirty (убрать немедленные IPC): `saveBrandPartActFlags` (:585), `updateBrandPartRow` (:634; убрать onBlur :1000), `bulkSetActFlag` (:604 — только setState), `detachBrandPart` (:659 — filter из стейта), `addPart` (:689 — строка без linkId). Создание НОВОЙ детали в справочнике (`createAndAddPart`) остаётся немедленным — это сущность справочника, не связь.
- `applyBrandPartsDiff()` при сохранении: removed → `deletePartSpecBrandLink`, added → `upsertPartSpecBrandLink`, changed → upsert с linkId; при частичном фейле dirty не сбрасывать; успех → invalidate cache → `loadBrandParts` → `persistBrandSummaryFromRows`. Контракт PartSpecBrandLink не менять (gotcha zod strip).
- `saveAllAndClose` включает дифф; reset = `loadBrand` + `loadBrandParts`.
- «Распространить на группу» (`runPropagate`): блокировать запуск при dirty («Сначала сохраните карточку»).
- Вложения (`saveAttachments`) — оставить немедленными (файлы).
- Recovery-draft: расширить снапшот `{name, description}` полем `parts?` (опционально, обратная совместимость), `brandParts` в deps автосейва драфта.

## PR-2, нитка C — админ-редакторы

- `AdminPage.tsx` — единственный реальный очаг: у `FieldEditor` убрать сохранение из onBlur (number :1862, json :1881, text :1977) и из onChange (date :1842, link :1903, lookup :1937); общая кнопка **«Сохранить»** в шапке «Карточки записи» (:1133) с dirty-набором изменённых кодов; включить туда же name марки (:1150) и `updateBrandParts` (:1173).
- `WarehouseLocationsAdminPage.tsx` — уже кнопочная (saveRow :105) — не трогаем.
- `AccessSectionsPage.tsx` — onBlur лишь закрывает пикер, setLevel — явное действие — не трогаем.

## Верификация

1. `corepack pnpm -F @matricarmz/shared build` → typecheck+lint по пакетам (последовательно) → shared unit (новые тесты: computeWorkOrdersStatusSummary, сортировка shippedDate) → backend tests.
2. verifier-electron e2e:
   - **PR-1:** пресет «Наряды» не строится сам; кнопка «Сформировать отчёт» строит; изменение фильтра — бейдж; колонка «Отгружен» с датой у двигателя со `status_customer_sent_date`; сводка в подвале (все 7 счётчиков); чекбокс разбивки по маркам добавляет таблицу.
   - **PR-2:** правка галочки/кол-ва в списке деталей марки НЕ пишется в БД до «Сохранить» (перечитать через bridge); закрытие карточки с правками — вопрос; «Сохранить» применяет дифф (add/change/detach); reset откатывает. AdminPage: правка поля → кнопка «Сохранить» активна, до неё БД не тронута.

## Файлы

PR-1: `shared/src/domain/workOrdersReport.ts`, `shared/src/domain/reports.ts`, `electron-app/src/main/services/reportPresetService.ts`, `electron-app/src/renderer/src/ui/utils/reportUtils.ts`, `electron-app/src/renderer/src/ui/pages/ReportPresetPage.tsx`.
PR-2: `electron-app/src/renderer/src/ui/pages/EngineBrandDetailsPage.tsx`, `electron-app/src/renderer/src/ui/pages/AdminPage.tsx`.

После одобрения скопировать план в `docs/plans/report-shipped-and-explicit-save.md`. Детальный черновик проектировщика: `C:\Users\valstan\.claude\plans\swift-wibbling-dewdrop-agent-a992a722f0e162a17.md`.

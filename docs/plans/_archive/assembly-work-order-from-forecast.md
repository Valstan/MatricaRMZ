# Assembly Work Order from Forecast — план

> Создан 2026-05-27. Большая нитка: связать «Прогноз сборки двигателей» с реальными нарядами на сборку через систему складских документов с резервацией деталей.

## Контекст

**Сегодня:** кнопки «Распечатать наряд-задание» в отчёте `assembly_forecast_7d` ([AssemblyForecastReportView.tsx:209-226](../../electron-app/src/renderer/src/ui/components/AssemblyForecastReportView.tsx#L209)) **не создают ничего в БД** — они генерируют локальный print-preview с фейк-номером `НЗ-YYYYMMDD-XX`. Прогноз генерируется автоматически на mount + по debounce при изменении фильтров ([ReportPresetPage.tsx:267-276](../../electron-app/src/renderer/src/ui/pages/ReportPresetPage.tsx#L267)). Assembly-наряды существуют, но lifecycle сейчас «единый шаг»: `closeWorkOrderAndPostDocument` создаёт `assembly_consumption` сразу `draft → planned → posted` без промежуточной паузы ([workOrderClosingService.ts:145-365](../../backend-api/src/services/workOrderClosingService.ts#L145)).

**Резервация частично готова:** `erp_reg_stock_balance.reservedQty` присутствует в схеме, прогноз читает `qty - reservedQty` как доступное ([warehouseForecastService.ts:46-58](../../backend-api/src/services/warehouseForecastService.ts#L46)). Но никто пока инкрементирует резерв при создании draft-документа.

**Цель:** оператор из отчёта прогноза выписывает наряд на сборку → детали сразу заморожены (видны в прогнозе как «занятые») → когда наряд проводится, детали списываются с конкретных складов → при удалении черновика резерв разворачивается.

## Ключевые решения (приняты на старте плана)

1. **Склад per-line, не per-order.** Каждая строка детали в Assembly-наряде имеет свой `sourceWarehouseId` (поле уже есть в `WorkOrderConsumedLine`). UI — добавить колонку «Склад» в таблицу деталей с dropdown. Опциональный «склад по умолчанию для новых строк» в шапке наряда — UX-сахар, добавлю если станет тесно.
2. **Assembly_consumption — полноправный складской документ.** Видим в `StockDocumentsPage` в любом статусе (draft/planned/posted). Lifecycle: «Сохранить» → draft (резерв через `reservedQty +=`), «Провести» → posted (списание `qty -= reserve`, `reservedQty -= reserve`), «Удалить черновик» → удаление документа + декремент резерва.
3. **Нет нового enum WorkOrderStatus.** Существующая семантика `operations.status` сохраняется: `open` пока документ draft/planned, `closed` когда документ posted. «Сохранён» = есть `linkedDocumentId` со status=draft.
4. **Stable variant key** для блокировки кнопки в прогнозе: `sha1(plannedDate + engineBrandId + sortedPartNomenclatureList)` хранится в payload Assembly-наряда. На загрузке прогноза подтягиваем активные (не deleted) Assembly-наряды → блокируем кнопки для уже выписанных вариантов.
5. **Пополнения готовой продукции** — НЕ в этой нитке. Уже частично работает (engine phase переходит в InAssembly при posting assembly_consumption — [warehouseService.ts:3040](../../backend-api/src/services/warehouseService.ts#L3040)). Расширение (пополнение склада готовых двигателей) — отдельная фича, не блокирует эту.

## Этапы

### Stage 1 — Backend: lifecycle draft → posted с резервом ✅ цель

**Файлы:**
- `backend-api/src/services/workOrderClosingService.ts` — разделить `closeWorkOrderAndPostDocument` на два метода: `saveAssemblyWorkOrder` (создаёт документ в draft + резервирует) и `postAssemblyWorkOrder` (переводит в posted). Существующий `closeWorkOrderAndPostDocument` остаётся для backward-compat (Repair, Workshop-deprecated, Manufacturing).
- `backend-api/src/services/warehouseService.ts` — `planWarehouseDocument` / `postWarehouseDocument` уже работают через статусы. Проверить что для `draft` статуса `reservedQty` инкрементируется (если нет — добавить шаг `reserveDraftMovements`).
- `backend-api/src/routes/workOrders.ts` — новые endpoints POST `/work-orders/:id/save-as-draft` (Assembly only) и POST `/work-orders/:id/post`.
- `shared/src/ipc/types.ts` — IPC bridge для двух новых методов.
- `electron-app/src/preload/index.ts` + `electron-app/src/main/ipc/register/workOrders.ts` — IPC handlers.

**Тесты:** unit-тесты на новые методы (`saveAssemblyWorkOrder` → reservedQty++, `postAssemblyWorkOrder` → qty-- && reservedQty--, delete-draft → reservedQty--).

**Backward-compat:** существующие закрытые assembly-наряды на проде имеют `linkedDocumentId` со status=posted — они продолжают работать. Открытые (без linkedDocumentId) — после деплоя оператор может либо «Сохранить» (создать draft), либо «Провести» сразу (legacy путь через старый `closeWorkOrderAndPostDocument` сохраняется).

**Риск:** разделение draft/posted потребует UI-различения, поэтому Stage 1 ставит только backend; Stage 4 переключает UI.

---

### Stage 2 — UI: колонка «Склад деталей» в Assembly-наряде

**Файлы:**
- `electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx` — секция Assembly: добавить колонку «Склад» в таблицу деталей. Dropdown — из списка складов (фильтр `directory_kind = warehouse`). Default — пусто (оператор обязан выбрать).
- Возможно — UX-сахар «склад по умолчанию» в шапке: dropdown «Склад по умолчанию для новых строк», при добавлении строки подставляется в `sourceWarehouseId`.
- `WorkOrderConsumedLine.sourceWarehouseId` — уже в shared/types, валидация: required на «Сохранить как черновик».
- Если в Assembly-наряде уже есть строки без `sourceWarehouseId` (legacy) — warning + блок «Сохранить» до заполнения.

**Тесты:** smoke — создание assembly-наряда, валидация что Сохранить требует склад в каждой строке.

---

### Stage 3 — Прогноз: ручная генерация + кеш

**Файлы:**
- `electron-app/src/renderer/src/ui/pages/ReportPresetPage.tsx` — убрать `useEffect(filtersKey → buildPreview)`. Добавить кнопку «Сформировать прогноз». Сохранять последний `preview` в state + persistance (electron-store через main).
- `electron-app/src/main/ipc/register/reports.ts` (или похожий) — IPC `reports.persistedPreview.get/set` для долговременного кеша (переживает navigate away и restart).
- Индикатор «фильтры изменились — нажмите Сформировать» если текущие фильтры не совпадают с теми, под которые построен последний кеш.
- Кеш per-presetId — ключ `assembly_forecast_7d` (другие пресеты пока auto-build остаётся).

**Тесты:** ручной smoke — открыть отчёт → есть старый результат → сменить фильтр → индикатор → нажать Сформировать → новый результат сохранён.

---

### Stage 4 — Кнопки «Создать наряд на сборку» вместо «Распечатать»

**Файлы:**
- `electron-app/src/renderer/src/ui/components/AssemblyForecastReportView.tsx` — переименовать кнопку, новый handler:
  ```ts
  onClick → window.matrica.workOrders.createAssemblyFromForecast({
    plannedDate, engineBrandId, parts: [...], variantKey
  }) → переход на /work-orders/:id
  ```
- Удалить локальную функцию `printWorkOrder()` + `WORK_ORDER_PRINT_STYLES` (печать живёт в `WorkOrderDetailsPage.tsx:799` через `printWorkOrderCard`).
- `backend-api/src/services/workOrderAssemblyFromForecastService.ts` (новый) — создаёт draft Assembly-наряд с предзаполненными строками. `sourceWarehouseId` — пытаемся подставить дефолтный склад номенклатуры; если нет — оставляем пусто, оператор заполнит. Stage 1 `saveAssemblyWorkOrder` сразу вызывается → детали зарезервированы.
- `forecastVariantKey` сохраняется в payload Assembly-наряда (`v3.forecastVariantKey`).
- `AssemblyForecastReportView` загружает список активных variant-key'ев из backend, для совпавших — кнопка disabled + «Наряд №NNN выписан» + ссылка на наряд.
- `backend-api/src/services/warehouseForecastService.ts` — после расчёта прогноза догрузить активные Assembly-наряды (без deleted, без posted... хотя posted тоже нужны? нет — если наряд проведён, детали уже списаны и в прогноз они не попадают), вернуть как `existingAssemblyOrdersByVariantKey: Record<string, { id, workOrderNumber }>`.

**Тесты:** ручной smoke — построить прогноз, нажать «Создать наряд» → редирект на карточку → детали с предзаполненными nomenclatureId/qty/sourceWarehouseId → склад пуст для тех где нет дефолта → сохранил → вернулся в прогноз (или построил заново) → видим «Наряд №NNN выписан», кнопка disabled.

---

### Stage 5 — Релиз v1.29.0

1. `node scripts/bump-version.mjs --set 1.29.0`
2. Запись в `RELEASE_WELCOME_HISTORY` (shared/src/domain/releaseWelcome.ts).
3. PR с CHANGELOG → merge → tag → installer build.
4. Прод: `git pull`, `pnpm -F shared -F backend-api -F web-admin build`, `pnpm -F backend-api db:migrate` (если будут новые миграции), restart services.
5. Документация в `DEVELOPMENT_LOG.md`.

## Открытые вопросы (не блокирующие)

- **Что делать с уже существующими open assembly-нарядами на проде?** Их мало (по handoff'у `v1.28.1` — единицы). После Stage 1 они получат опцию «Сохранить как черновик» или «Провести сразу» — без миграции данных. Если оператор оставит их open — продолжают работать.
- **«Склад по умолчанию» в шапке наряда — нужен ли?** Решу по ходу Stage 2 — если строк обычно >5 и все с одного склада, UX-сахар оправдан.
- **Кеш прогноза в Stage 3 — TTL или ручная инвалидация?** Думаю, только ручная (нажать «Сформировать» = новый снапшот). TTL может удивить оператора.
- **Пополнение склада готовых двигателей при проведении** — не в этой нитке. Engine phase уже переходит в InAssembly. Если нужен отдельный складской документ-пополнение — отдельная фича.

## Прогресс

- [ ] Stage 1 — Backend lifecycle (save / post / delete-draft + reserve)
- [ ] Stage 2 — UI колонка «Склад» в строках Assembly-наряда
- [ ] Stage 3 — Ручная генерация прогноза + долговременный кеш
- [ ] Stage 4 — Кнопка «Создать наряд» + блокировка для уже выписанных
- [ ] Stage 5 — Release v1.29.0

## Ссылки

- Прогноз UI: [AssemblyForecastReportView.tsx](../../electron-app/src/renderer/src/ui/components/AssemblyForecastReportView.tsx)
- Прогноз backend: [warehouseForecastService.ts](../../backend-api/src/services/warehouseForecastService.ts)
- Pure forecast logic: [assemblyForecast.ts](../../shared/src/domain/assemblyForecast.ts)
- Closing service: [workOrderClosingService.ts](../../backend-api/src/services/workOrderClosingService.ts)
- Warehouse service: [warehouseService.ts](../../backend-api/src/services/warehouseService.ts)
- Schema (stock balance): [schema.ts:1232-1252](../../backend-api/src/database/schema.ts#L1232)
- WO types: [workOrder.ts](../../shared/src/domain/workOrder.ts)

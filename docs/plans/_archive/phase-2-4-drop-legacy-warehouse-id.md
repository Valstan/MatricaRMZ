# Phase 2.4 — Drop legacy `warehouse_id`

**Owner:** Claude + Valstan
**Started:** 2026-05-27
**Status:** ⏳ in plan review

## Контекст и мотивация

Серия Phase 2.x (миграция складов на FK-связь `warehouse_locations`) застряла на финальном шаге. После Phase 2.1–2.3 в БД параллельно живут две колонки в 4 регистрах:

- `warehouse_id text` — legacy, формат `'default'` / `'repair_fund'` / `'scrap'` / `'assembly_in_progress'` / `'workshop_<code>'`
- `warehouse_location_id uuid` — FK на `warehouse_locations`, заполняется plpgsql-триггером

Этот дуализм породил конкретный баг (нитка `assembly-work-order-from-forecast`): прогноз сборки читает `warehouse_location_id` (видит все склады), а резерв наряда — `warehouse_id` с проверкой `parseWorkshopWarehouseId` (видит только `workshop_*`). Оператор видит наличие на «Основном складе», но создать черновик не может — фолбэк на `workshop_<code>` цеха, где остатков нет.

**Цель Phase 2.4:** дропнуть legacy `warehouse_id` целиком. Тогда:

- Наряд на сборку становится полноправным документом складского учёта — может работать с любым типом склада (system / regular / workshop), резерв ищет по `warehouse_location_id`.
- Уходит trigger `sync_warehouse_location_id()` и риск рассинхрона между двумя колонками.
- Sync protocol упрощается — клиент получает один UUID-идентификатор склада.
- shared-константы string-кодов превращаются в UUID-резолверы (или удаляются).

## Объём

| Слой | Файлов | Usages |
|---|---|---|
| Backend (`backend-api/src/`) | 16 | 131 |
| Shared (`shared/src/`) | 9 | 88 |
| Electron-app (`electron-app/src/`) | 16 | 152 |
| **Итого** | **~40** | **~371** |

Hot-spots:
- `backend-api/src/services/warehouseService.ts` — 50 usage (UPSERT keys, WHERE eq, 30+ TS-фильтров)
- `electron-app/src/renderer/src/ui/pages/StockDocumentDetailsPage.tsx` — 23 usage
- `electron-app/src/renderer/src/ui/pages/WarehouseLocationsPage.tsx` — 21 usage
- `electron-app/src/main/services/erpService.ts` — 20 usage

## Технические решения (фиксирую без отдельного согласования)

### 1. UUID для system locations: резолвер с кэшем, не магические seed-UUID

System-локации (`default`, `repair_fund`, `scrap`, `assembly_in_progress`) сейчас идентифицируются string-кодами. После DROP COLUMN — обычные `warehouse_locations` row с `type='system'` и `code='<имя>'`.

**Решение:** в shared не зашивать конкретные UUID, а ввести backend-резолвер `getSystemLocationIdByCode(code) → uuid` с кэшированием в памяти. Frontend через IPC получает `warehouseLocations.list()` — каждая локация приходит со своим UUID, маппинг code→UUID делается в одной точке загрузки.

Альтернатива (фикс-сидед UUID на базе NIL+offset) отвергнута: усложняет seed-механизм при свежей установке, делает миграцию ломкой при существующих рандомных UUID на проде.

### 2. Workshop-локации: убираем префикс, остаются `code='workshop_<N>'`

Сейчас workshop-склад идентифицируется как `'workshop_<code>'` через `parseWorkshopWarehouseId`. После Phase 2.4:

- `warehouse_locations` row с `type='workshop'`, `code='workshop_<N>'` (префикс остаётся в БД как часть кода для совместимости с прошлым backfill'ом).
- Helpers `workshopWarehouseId`, `parseWorkshopWarehouseId`, `isWorkshopWarehouseId`, `WORKSHOP_WAREHOUSE_PREFIX` — **удаляются**. Логика «это цеховой склад?» переходит на проверку `location.type === 'workshop'`.

### 3. Sync protocol: ledger по-прежнему отдаёт оба поля в PR 1, только UUID в PR 2

Phase 2.4.1 (✅ v1.18.5) уже добавил SQLite-колонку `warehouse_location_id` text и расширил `shared/sync/registry.ts` + `shared/erpDto.ts`. Старые клиенты молча игнорируют новое поле (zod strip).

- **PR 1:** ledger продолжает отдавать оба поля `warehouse_id` + `warehouse_location_id`. Новый клиент пишет/читает UUID, старый — string-код через trigger.
- **PR 2 (DROP):** ledger отдаёт только `warehouse_location_id`. Старые клиенты с v1.18.4 и ниже — больше не получают `warehouse_id` в sync row и могут начать терять записи. Граница совместимости: **клиенты ≥ v1.19.0** (где SQLite-колонка появилась) поддерживаются, ниже — нет. На момент PR 2 на проде должны быть только клиенты v1.19+.

### 4. Граница PR 1 / PR 2: внешняя поверхность сначала, DROP COLUMN потом

**PR 1 (v1.30.0) — внутренняя миграция, БЕЗ DROP:**
- Backend весь переключается на чтение/запись `warehouse_location_id` (включая UPSERT keys, WHERE eq, in-memory filters).
- Frontend dropdown расширяется на все активные локации (фикс бага пользователя).
- API payload отдаёт только `warehouseLocationId` (`warehouseId` — strip из output). Внутренний legacy stays в БД, trigger живёт.
- Перенос «прогноз → наряд» (workOrders.ts:82) передаёт `warehouseLocationId`.
- Решает практически весь баг пользователя в первом релизе, без DDL-риска.

**Audit-gate между PR 1 и PR 2 (≥ 1 неделя на проде):**
- На проде смотрим `SELECT * FROM warehouse_id_orphans;` — `n=0` во всех 4 регистрах.
- Sentry/логи: нет ошибок типа «warehouse_location_id is null» в новых документах.
- Прод-телеметрия: все клиенты в полевой версии ≥ v1.19.0 (нет клиентов v1.18.x).

**PR 2.5 (v1.30.2) — зеркало `warehouse_locations` в SQLite + рефактор отчётов:**

Между PR 2 (v1.30.1, narrow DB-уровень) и DDL cleanup нужно перевести клиентские отчёты с legacy `raw.warehouseId` (text-код) на `raw.warehouseLocationId` (uuid). Для этого:
- Добавить SQLite-таблицу `warehouse_locations` (зеркало PG) + sync registration в shared registry / erpDto.
- Backend sync — отдавать warehouse_locations changes через ledger.
- `electron-app/src/main/services/reportPresetService.ts` — переключить ~7 точек: warehouseFilter compare на `raw.warehouseLocationId`, type-checks (`startsWith('workshop_')` / `=== 'repair_fund'`) — через lookup в локальной `warehouse_locations` по uuid → `type` / `code`. Один lookup-map per build.
- `warehouseLocationLabel(warehouseId, ...)` — заменить на lookup по uuid → `name`.

Без этого PR 3 (DROP COLUMN) ломает все workshop-specific отчёты.

**PR 3 (v1.31.0) — DDL cleanup:**
- DROP TRIGGER × 4, DROP FUNCTION.
- ALTER TABLE × 4 DROP COLUMN `warehouse_id`.
- SQLite клиент: DROP COLUMN × 3 (table recreate).
- Drizzle backend schema cleanup (поля + 6 индексов).
- shared/warehouseLocations.ts: удалить string-константы и workshop-helpers.
- Удалить `ensureDefaultWarehouse()`, `normalize_uuid_warehouseids.sql` admin-скрипт.
- Удалить/мигрировать 2 soft-deleted EAV `warehouse_ref` «призрака» (см. PENDING_FOLLOWUPS).
- Ledger: отдаёт только `warehouse_location_id`.

---

## PR 1 — Внутренняя миграция на `warehouse_location_id` (v1.30.0)

### 1.1 Backend

#### 1.1.1 Резолвер system UUIDs
**Новый файл** `backend-api/src/services/warehouseLocationsResolver.ts`:
- `getSystemLocationIdByCode(code: 'default' | 'repair_fund' | 'scrap' | 'assembly_in_progress'): Promise<string>` — lookup в `warehouse_locations` с кэшем.
- `getWorkshopLocationIdByCode(code: string): Promise<string | null>` — для workshop_<code>.
- `getLocationIdByLegacyWarehouseId(legacy: string): Promise<string | null>` — универсальный fallback на время миграции (для backfill-скриптов).

#### 1.1.2 warehouseService.ts (50 usages)
- **UPSERT keys** ([`warehouseService.ts:2763`](../backend-api/src/services/warehouseService.ts) WHERE eq) — переписать на `eq(erpRegStockBalance.nomenclatureId, nomenclatureId), eq(erpRegStockBalance.warehouseLocationId, locationId)`. Code → UUID lookup в момент проводки документа.
- **30+ TS in-memory filters** (`row.warehouseId === ...`) → переключить на `row.warehouseLocationId === ...`.
- **Payload-сборки** для list/get endpoints — отдавать `warehouseLocationId` (UUID), не `warehouseId` (string code).
- **`listWarehouseStock`** (orderBy уже на warehouseLocationId после v1.20.0) — проверить, что output полностью UUID.
- **`reserveAssemblyDraftReservation`** (line ~2700) — WHERE eq на `warehouseLocationId`, не `warehouseId`. Error message: использовать `warehouse_locations.name`, а не `<uuid>` (UX).
- **`releaseAssemblyDraftReservation`**, **`postAssemblyConsumption`** — симметричное переключение.

#### 1.1.3 workOrderClosingService.ts (2 usages)
- [`buildAssemblyDocLines:535`](../backend-api/src/services/workOrderClosingService.ts) — убрать `parseWorkshopWarehouseId`. Валидация: `sourceWarehouseId` обязан быть UUID существующей active локации. Если строка не указала склад — **ошибка** (не молчаливый фолбэк на `workshop_1`). Согласуется с user-preference «строгая блокировка > auto-fix».
- `args.workshopWh` — оставляем как fallback **только для шапочного uuid** (если строка не указала), но возвращаем error если он не задан.

#### 1.1.4 warehouseForecastService.ts (3 usages)
- Уже работает на `warehouseLocationId` ([line 47-59](../backend-api/src/services/warehouseForecastService.ts)). Проверить только что output API отдаёт UUID без string-codes.

#### 1.1.5 routes/warehouse.ts (10 usages), routes/ledger.ts (2 usages)
- **routes/warehouse.ts** — все request body параметры и response shape: `warehouseLocationId` UUID.
- **routes/ledger.ts:308,319** — sync row builder продолжает отдавать ОБА поля (`warehouse_id` для старых клиентов + `warehouse_location_id`). NO-OP в PR 1, изменится только в PR 2.

#### 1.1.6 Прочие сервисы
- `ai/claudeTools.ts` (7 usages) — AI tools отключены на проде из-за geo-block, но API контракт всё равно переключить: input/output на UUID.
- `warehouseBomService.ts` (3 usages), `erpService.ts` (3 usages), `stockBalanceForWorkshopService.ts` (1) — точечная замена column reference.

### 1.2 Shared

#### 1.2.1 Types
- `shared/src/domain/warehouse.ts` (12 usages) — переходные типы `StockBalance.warehouseLocationId: string` обязательным. `warehouseId?: string | null` оставить optional для backward-compat в PR 1, удалить в PR 2.
- `shared/src/ipc/types.ts` (7), `shared/src/sync/registry.ts` (3) — registry для sync уже имеет `warehouse_location_id` (v1.18.5), просто use it.

#### 1.2.2 Domain logic
- `shared/src/domain/assemblyForecast.ts` (25 usages) — переключить на warehouseLocationId. Pure-функции — лёгкая правка.
- `shared/src/domain/reports.ts` (6) — column key в пресетах отчёта: `warehouseLocationId`. Обновить пресеты + миграция legacy ColumnSettings.

#### 1.2.3 warehouseLocations.ts (11 usages)
- В PR 1 — **не трогаем**. String-константы и `parseWorkshopWarehouseId` остаются (нужны старым клиентам и trigger'у). Удаление — PR 2.

### 1.3 Electron-app

#### 1.3.1 WorkOrderDetailsPage.tsx
- [Line 348-354](../electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx) — `warehouseSourceOptions` убрать filter `type === 'workshop'`. Все активные локации (system + workshop + regular). Опции с `id: w.id` (UUID), label: `warehouseLocationLabel(w.code, w.name)` или прямо `w.name`.
- [Line 1804](../electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx) — `value={line.sourceWarehouseId}` теперь UUID. Совместимость со старыми payload (где было `workshop_<code>`) — поддерживать только на read: если значение — workshop string, резолвить в UUID при первой загрузке (one-time auto-fix через прогон существующих open assembly orders).

#### 1.3.2 main/ipc/register/workOrders.ts
- [Line 82-101](../electron-app/src/main/ipc/register/workOrders.ts) — при формировании freeWorks из прогноза подставлять `sourceWarehouseId: <UUID>` если из строки прогноза доступен primary warehouse. Логика выбора склада: где деталь физически есть в наибольшем количестве, по убыванию (system 'default' приоритет, иначе workshop с большим остатком).

#### 1.3.3 Прочие страницы
- `StockBalancesPage.tsx` (11 usages), `StockInventoryPage.tsx` (12), `StockDocumentsPage.tsx` (7), `StockDocumentDetailsPage.tsx` (23) — переключить на UUID в state и API calls. UI label через `warehouseLocationLabel`.
- `WarehouseLocationsPage.tsx` (21 usages) — переключить uuid-группировку (была отложена в v1.20.0).
- `MasterdataWorkshopsPage.tsx` (2), `NomenclatureDetailsPage.tsx` (4), `ReportPresetPage.tsx` (2), `WarehouseLocationsAdminPage.tsx` (1) — точечно.

#### 1.3.4 main services
- `erpService.ts` (20 usages), `syncService.ts` (4), `reportPresetService.ts` (24) — переключить state и DB-queries на UUID.

### 1.4 Тесты

- `backend-api/src/tests/warehouse.assemblyReserve.test.ts` — обновить под UUID parameter.
- `shared/src/domain/assemblyForecast.test.ts` (18 usages) — fixtures с UUID.
- `shared/src/domain/reports.test.ts` (1) — UUID column key.
- Новый integration test `backend-api/src/tests/warehouse.assemblyDraft.nonWorkshop.test.ts` — проверка что наряд резервирует с UUID-склада типа `regular` («Основной склад»).

### 1.5 Verifier-electron

После merge PR 1 — прогон скилла `/verify`:
- Создать TEST-WAREHOUSE regular-локацию.
- Оприходовать TEST-PART туда (без workshop'а).
- Сформировать прогноз сборки.
- Создать Assembly наряд из прогноза.
- Убедиться что dropdown «Склад» включает TEST-WAREHOUSE.
- Выбрать TEST-WAREHOUSE → «Сохранить как черновик» → проверить резерв.

### 1.6 Release

- `node scripts/bump-version.mjs --set 1.30.0`
- Добавить запись в `shared/src/domain/releaseWelcome.ts` (focus: наряд на сборку видит все склады).
- PR title: `feat: assembly work order on any warehouse type (Phase 2.4 PR 1)`.
- DB-миграции нет в этом PR. Только code switch.

---

## Audit gate (между PR 1 и PR 2)

**Минимум 1 неделя на проде после v1.30.0.** Контрольные точки перед стартом PR 2:

1. **Прод audit:** `SELECT * FROM warehouse_id_orphans;` — `n=0` во всех 4 регистрах. Если есть orphans — диагностировать и зачистить вручную до DROP.
2. **Sentry / диагностика:** нет ошибок «warehouse_location_id is null» в новых документах (последняя неделя).
3. **Клиенты в полевой версии:** все ≥ v1.19.0 (минимум для совместимости с PR 2 sync). Проверить через `/updates/status` + ledger telemetry per-client.
4. **Smoke оператора** на v1.30.0: создать наряд на «Основном складе» (не workshop) → провести → проверить движение в `erp_reg_stock_movements`.
5. **2 EAV warehouse_ref «призрака»** (soft-deleted) — решить: переименовать как regular в `warehouse_locations` или удалить hard. Не блокер PR 2, но проще закрыть параллельно.

Если хоть один пункт красный — PR 2 откладывается, чиним и audit-gate повторяется.

---

## PR 2 — DROP COLUMN + cleanup (v1.31.0)

### 2.1 DB migrations

**Новый файл** `backend-api/drizzle/0057_drop_warehouse_id.sql`:

```sql
-- Phase 2.4 final — drop legacy warehouse_id column from 4 registers.
-- Pre-conditions (verified on prod before merge):
--   - SELECT * FROM warehouse_id_orphans; → all n=0
--   - All field clients ≥ v1.19.0 (sync protocol drops warehouse_id from output)

DROP TRIGGER IF EXISTS sync_warehouse_location_id_balance ON erp_reg_stock_balance;
DROP TRIGGER IF EXISTS sync_warehouse_location_id_movements ON erp_reg_stock_movements;
DROP TRIGGER IF EXISTS sync_warehouse_location_id_engine_instances ON erp_engine_instances;
DROP TRIGGER IF EXISTS sync_warehouse_location_id_planned_incoming ON erp_planned_incoming;
DROP FUNCTION IF EXISTS sync_warehouse_location_id();

-- Drop indexes that include warehouse_id (Drizzle schema also has them).
DROP INDEX IF EXISTS erp_planned_incoming_warehouse_uq;
DROP INDEX IF EXISTS erp_planned_incoming_warehouse_date_idx;
DROP INDEX IF EXISTS erp_engine_instances_warehouse_idx;
DROP INDEX IF EXISTS erp_reg_stock_balance_part_warehouse_uq;
DROP INDEX IF EXISTS erp_reg_stock_balance_nomenclature_warehouse_uq;
DROP INDEX IF EXISTS erp_reg_stock_movements_nomenclature_warehouse_idx;

ALTER TABLE erp_reg_stock_balance    DROP COLUMN warehouse_id;
ALTER TABLE erp_reg_stock_movements  DROP COLUMN warehouse_id;
ALTER TABLE erp_engine_instances     DROP COLUMN warehouse_id;
ALTER TABLE erp_planned_incoming     DROP COLUMN warehouse_id;

-- Recreate UNIQUE / functional indexes on warehouse_location_id.
CREATE UNIQUE INDEX erp_reg_stock_balance_nomenclature_location_uq
  ON erp_reg_stock_balance (nomenclature_id, warehouse_location_id)
  WHERE nomenclature_id IS NOT NULL;
-- … остальные uniques + functional

DROP VIEW IF EXISTS warehouse_id_orphans;
```

**Новый SQLite** `electron-app/drizzle/0014_drop_warehouse_id.sql`:

```sql
-- SQLite DROP COLUMN requires table recreate (legacy SQLite ≤ 3.34 in some Electron versions).
-- Strategy: rename → create new without warehouse_id → INSERT … SELECT → drop old.

PRAGMA foreign_keys=OFF;

ALTER TABLE erp_reg_stock_balance RENAME TO __old_erp_reg_stock_balance;
CREATE TABLE erp_reg_stock_balance (...);  -- без warehouse_id
INSERT INTO erp_reg_stock_balance SELECT col1, col2, ... FROM __old_erp_reg_stock_balance;
DROP TABLE __old_erp_reg_stock_balance;
-- × 3 registers (engine_instances, movements, balance)

PRAGMA foreign_keys=ON;
```

### 2.2 Backend Drizzle schema

`backend-api/src/database/schema.ts`:
- Убрать поле `warehouseId: text('warehouse_id')` × 4 регистра (lines 1067, 1210, 1238, 1261).
- Убрать индексы по warehouseId × 6.
- Поле `defaultWarehouseId` в workshops (line 1029) — заменить на `defaultWarehouseLocationId: uuid('default_warehouse_location_id').references(() => warehouseLocations.id)`. Backfill миграция в том же DDL.

### 2.3 Backend code cleanup

- Удалить `ensureDefaultWarehouse()` если дублирует `getSystemLocationIdByCode('default')`.
- Удалить `listWarehouseLookups()` если дублирует.
- Удалить `scripts/migrations/normalize_uuid_warehouseids.sql` admin-скрипт.
- `routes/ledger.ts:308,319` — sync row отдаёт только `warehouse_location_id`. PR breaking-change для клиентов < v1.19.0.

### 2.4 Shared cleanup

`shared/src/domain/warehouseLocations.ts`:
- Удалить string-константы `WAREHOUSE_LOCATION_DEFAULT/_REPAIR_FUND/_SCRAP/_ASSEMBLY_IN_PROGRESS`.
- Удалить `WORKSHOP_WAREHOUSE_PREFIX`, `workshopWarehouseId`, `parseWorkshopWarehouseId`, `isWorkshopWarehouseId`, `SYSTEM_WAREHOUSE_LOCATIONS`, `isSystemWarehouseLocation`.
- Оставить `warehouseLocationLabel(location: WarehouseLocationRow): string` (берёт name из row).
- Все usages обновить на UUID + lookup через `warehouseLocations.list()`.

### 2.5 EAV «призраки»

2 soft-deleted regular-row («Локация 6f68ba3b…», «Локация cfcb2984…») — это были EAV `warehouse_ref` с реальными именами «Основной склад» и «Склад цеха № 4».

**Решение:** удалить hard через admin-скрипт `scripts/cleanupEavWarehouseRef.ts --apply`. На проде они уже soft-deleted, нагрузки нет.

### 2.6 Тесты

- Полный прогон тестов после удаления warehouseId полей — фиксить компиляционные ошибки.
- Sync protocol test: новый клиент получает UUID, старый протокол не поддерживается.

### 2.7 Release

- `bump-version 1.31.0`
- `releaseWelcome` запись (focus: «технический релиз, упростили внутреннее устройство склада — багов быть не должно»).
- PR title: `chore: drop legacy warehouse_id, finalize Phase 2.4 (PR 2)`.
- На проде: `db:migrate` обязательно. Прогон в dev/staging до прода.

---

## Контрольные точки и риски

### Риски PR 1

| Риск | Митигация |
|---|---|
| 50 точек в warehouseService.ts — пропустить filter | Grep `\.warehouseId` после каждой правки секции, добавить TS-проверку в CI (lint-rule no-warehouse-id?) |
| Sync ломает старых клиентов | В PR 1 ledger продолжает отдавать оба поля. Старые клиенты не замечают изменений. |
| Прогноз → наряд: выбор «лучшего склада» неочевиден | По умолчанию — НЕ подставлять, оператор выбирает вручную. Авто-подстановка — отдельный followup. |
| Existing open Assembly orders с `workshop_<code>` в payload | Backend route принимает оба формата, авто-резолв через `getLocationIdByLegacyWarehouseId`. Документ обновляется при первом save. |

### Риски PR 2

| Риск | Митигация |
|---|---|
| Клиент < v1.19.0 в полевой работе на момент DROP | Audit-gate перед PR 2: `/updates/status` per-client telemetry. Если есть — откладываем. |
| `warehouse_id_orphans` > 0 на проде | Audit-gate. Если есть — диагностируем и зачищаем вручную. |
| SQLite table-recreate — потеря данных при отказе | Транзакция + бекап SQLite файла перед миграцией. Электрон-апдейтер уже это делает. |
| Existing reports / ColumnSettings со старыми column keys | Миграция шаблонов отчётов на новые keys в одном PR с DROP. Один раз и забыли. |

### Откат

- **PR 1:** обычный revert PR. Trigger в БД остаётся, dual-write продолжается, ничего не сломано.
- **PR 2:** revert DDL невозможен (DROP COLUMN). Перед merge — `pg_dump` schema, при критической проблеме — accept lengthier downtime, восстановить колонки, backfill из ledger. Поэтому audit-gate жёсткий.

---

## Финальный итог

После PR 2:
- В БД остаётся одна колонка `warehouse_location_id uuid` FK на `warehouse_locations`.
- Любая локация работает как «полноправный склад» в любом документе.
- Нет string-кодов, нет parseWorkshopWarehouseId, нет dual-write.
- Phase 2 закрыта полностью. Phase 2.5 / следующий шаг — на усмотрение пользователя.

Закрываемые пункты PENDING_FOLLOWUPS:
- ⏳ Phase 2.4 (drop legacy warehouse_id) — закрыто.
- 2 EAV warehouse_ref «призрака» — закрыто.
- Часть Phase 2.4.3 prep-этапов, отложенных в v1.20.0 (WHERE eq UPSERT, 30+ TS-фильтры, UI WarehouseLocationsPage uuid-группировка, shared/reports.ts column key) — закрыты в PR 1.

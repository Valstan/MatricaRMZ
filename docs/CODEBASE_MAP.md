# MatricaRMZ — Codebase Map

Куратируемая карта где что живёт. **Не автогенерируется**, обновляется при значимых архитектурных изменениях. Цель — навигация от понятия к файлу за один взгляд, без широкой разведки на старте сессии.

История релизов — `git log` + тело PR; навигация по сделанному — [`COMPLETED.md`](COMPLETED.md). Открытые задачи — [`PENDING_FOLLOWUPS.md`](PENDING_FOLLOWUPS.md). Грабли по симптомам — [`GOTCHAS.md`](GOTCHAS.md). Архитектура и правила — [`PROJECT_STATE.md`](PROJECT_STATE.md). Активная нитка — [`SESSION_HANDOFF.md`](SESSION_HANDOFF.md).

## Монорепо (pnpm workspaces)

| Пакет | Что | Когда сюда лезть |
|---|---|---|
| [`electron-app/`](../electron-app) | Electron + React UI клиент (renderer + main + preload) | UI, формы, главное окно, IPC, локальная SQLite |
| [`backend-api/`](../backend-api) | Express REST API + Drizzle ORM (PostgreSQL) | API endpoints, бизнес-логика, миграции, фоновые job'ы |
| [`shared/`](../shared) | Общие типы и pure-логика TS | Изменения видимые и UI и API, доменные правила (BOM, forecast, signatures) |
| [`web-admin/`](../web-admin) | Веб-админка (React, отдельно от Electron) | Админ-задачи через браузер |
| [`ledger/`](../ledger) | Encrypted event log + keyring (enc:v1/v2) | Шифрование sync-пакетов, ротация ключей |
| [`scripts/`](../scripts) | Корневые CLI: bump-version, release-ledger | Релизный процесс (см. `CLAUDE.md` §Release) |
| [`deploy/`](../deploy) | nginx config + systemd units | Прод-конфигурация nginx / systemd таймеры |

## Backend (`backend-api/src/`)

| Домен | Файл(ы) | Когда сюда лезть |
|---|---|---|
| **BOM спецификация двигателя** | `services/warehouseBomService.ts`, `services/warehouseBomLineMeta.ts` | BOM-refactor (см. план `docs/plans/bom-refactor-2026-05.md`), variantGroup, parentLineKey, схема компонентов |
| **Номенклатура (Phase 1)** | `services/warehouseService.ts:1500–1700`, `scripts/auditPartsMirror.ts`, `scripts/fixPartsMirror.ts`, `scripts/migrateComponentTypeFromSpecJson.ts` | Component types, `directory_kind`, зеркало parts↔nomenclature, миграция Directories→Nomenclature |
| **Склад (3 регистра)** | `services/warehouseService.ts`, `services/warehouseLocationsService.ts` | Stock balances, документы прихода/расхода/перемещения, FK warehouse_location_id (Phase 2.x) |
| **Прогноз сборки** | `services/warehouseForecastService.ts` | Прогноз 7 дней, kit-варианты, edge cases (см. v1.22.0 блок A) |
| **Наряды** | `services/workOrderClosingService.ts`, `services/servicePricingService.ts` | 4 типа нарядов (Regular/Repair/Assembly/Manufacturing), подписи, ценообразование услуг |
| **Sync + Ledger** | `routes/sync.ts`, `routes/ledger.ts`, `services/masterdataSyncService.ts`, `services/syncPipelineSupervisorService.ts` | Синхронизация клиент↔сервер, ledger event log, supervisor (singleton на primary) |
| **AI** | `services/aiAgent*.ts`, `services/ai/claudeTools.ts` | AI-tools, learning, chat — **выключено на проде** ([Anthropic geo-block](PENDING_FOLLOWUPS.md#-блокер-anthropic-api-блокирует-рф-ip)) |
| **Auth / Users** | `routes/auth.ts`, `services/employeeAuthService.ts`, `services/userDeletionService.ts` | Логин сотрудников, GDPR-delete, refresh tokens |
| **Reports** | `routes/reports.ts`, пресеты в `shared/src/domain/reports.ts` | Отчёты (forecast, payroll, stock-audit), HTML-рендер для печати |
| **Diagnostics / Critical events** | `services/diagnostics*.ts`, `services/criticalEventsService.ts`, `services/criticalEventsTelegramService.ts` | Прод-диагностика, autoheal, Telegram-уведомления |
| **Updates** | `routes/updates.ts`, `services/updateTorrentService.ts` | Раздача Windows-installer'ов (`.exe` + `latest.yml`), торрент |
| **Маршруты** | `backend-api/src/routes/*.ts` | Точка входа Express: `warehouse`, `workOrders`, `parts`, `erp`, `sync`, `ledger`, `auth`, ... |
| **Drizzle schema** | `backend-api/src/database/schema.ts` | Поля колонок, индексы, FK; миграции в `backend-api/drizzle/` (последняя — `0059`) |

## Frontend (`electron-app/src/renderer/src/ui/`)

| Меню / страница | Файл | Когда сюда лезть |
|---|---|---|
| **Склад** | `pages/StockBalancesPage.tsx`, `StockDocumentsPage.tsx`, `StockDocumentDetailsPage.tsx`, `StockInventoryPage.tsx` | Остатки, документы прихода/расхода, инвентаризация |
| **Склад → Локации** | `pages/WarehouseLocationsPage.tsx`, `WarehouseLocationsAdminPage.tsx` | Управление складами/цехами (Phase 2 FK-миграция) |
| **Склад → Номенклатура** | `pages/NomenclaturePage.tsx`, `NomenclatureDirectoryPage.tsx`, `NomenclatureDetailsPage.tsx` | Карточка номенклатуры, component_type_id (нативная колонка), templates |
| **Склад → BOM сборки** | `pages/EngineAssemblyBomPage.tsx`, `EngineAssemblyBomDetailsPage.tsx` | BOM спецификация двигателя, режим дерева, варианты сборки |
| **Снабжение** | `pages/SupplyRequestsPage.tsx`, `SupplyRequestDetailsPage.tsx`, `ServicesPage.tsx`, `ServicesByBrandPage.tsx`, `SupplyToolMovementsPage.tsx` | Заявки в снабжение, услуги (с фильтром по марке) |
| **Производство** | `pages/WorkOrdersPage.tsx`, `WorkOrderDetailsPage.tsx`, `EnginesPage.tsx`, `EngineDetailsPage.tsx` | Наряды (4 типа), двигатели, контракты на ремонт |
| **Справочники** | `pages/PartsPage.tsx`, `PartDetailsPage.tsx`, `ToolsPage.tsx`, `ProductsPage.tsx`, `EngineBrandsPage.tsx`, `EmployeesPage.tsx`, `CounterpartiesPage.tsx`, `MasterdataDirectoryPage.tsx`, `SimpleMasterdataDetailsPage.tsx` | Детали, инструменты, изделия, марки, сотрудники, контрагенты. EAV-атрибуты регистрируются в `ensureAttributeDefs` внутри `SimpleMasterdataDetailsPage.tsx` |
| **Отчёты** | `pages/ReportsCatalogPage.tsx`, `ReportsPage.tsx`, `ReportPresetPage.tsx` | Каталог пресетов, параметры, экспорт HTML/печать |
| **Админ** | `pages/AdminPage.tsx`, `AdminUsersPage.tsx`, `SuperadminAuditPage.tsx`, `AuditPage.tsx`, `HistoryPage.tsx`, `ChangesPage.tsx` | Пользователи, аудит, история изменений |
| **Auth / Settings** | `pages/AuthPage.tsx`, `SettingsPage.tsx` | Логин, локальные настройки |
| **Главное окно / IPC** | `electron-app/src/main/`, `electron-app/src/preload/`, `electron-app/src/renderer/src/main.tsx` | Bootstrap, миграции SQLite, IPC bridges, autoupdater |

## Shared domain (`shared/src/domain/`)

| Файл | Что описывает |
|---|---|
| `warehouse.ts` | `resolveNomenclatureComponentTypeId` (приоритет column → specJson → эвристика), BOM-валидация, types для склада |
| `assemblyForecast.ts` | Pure-логика прогноза сборки (kit'ы, варианты, edge cases) |
| `workOrder.ts`, `workOrderSignatures.ts` | Типы нарядов, расчёт ФИО подписантов |
| `reports.ts` | Реестр пресетов отчётов, типы параметров |
| `releaseWelcome.ts` | `RELEASE_WELCOME_HISTORY` — текст для оператора при автообновлении |
| `permissions.ts`, `signatureAccess.ts` | Роли и доступ к подписям |
| `part.ts`, `contract.ts`, `employees.ts`, `supplyRequest.ts` | Доменные типы остальных сущностей |
| `enums.ts`, `systemIds.ts`, `linkFieldRules.ts` | Перечисления, системные UUID, правила связей |

## БД

- **PostgreSQL 17 (prod, 17.8):** основная БД. Миграции — [`backend-api/drizzle/*.sql`](../backend-api/drizzle). Последняя merged: `0059_directory_parts_spec_columns.sql`. Drizzle schema: `backend-api/src/database/schema.ts`.
- **SQLite (клиент):** локальный кэш. Миграции — `electron-app/drizzle/`. Накат при старте Electron.
- **EAV (`attribute_values`):** атрибуты сущностей без DDL. Новые атрибуты регистрировать в `ensureAttributeDefs` (`SimpleMasterdataDetailsPage.tsx`). См. `CLAUDE.md` §EAV.
- **Ledger (encrypted event log):** [`ledger/`](../ledger), keyring enc:v2 (multi-key, backward-compat с enc:v1).

## Deploy / Operations

- **Prod VPS:** jino.ru (`195.161.41.30`), SSH alias `matricarmz` через `~/.ssh/id_ed25519_matricarmz_deploy`. fail2ban aggressive — не долбить логином при ошибке, разбираться. См. `docs/OPERATIONS.md`, `docs/WINDOWS_DEVELOPMENT.md` §8.
- **Services (dual-instance):** `matricarmz-backend-primary.service` (`:3001`) — singleton job'ы; `matricarmz-backend-secondary.service` (`:3002`) — только API. nginx upstream.
- **nginx:** [`deploy/nginx/matricarmz-backend.conf`](../deploy/nginx/matricarmz-backend.conf) (catch-all `location /` + спец-блоки), выкат через [`deploy/nginx/install.sh`](../deploy/nginx/install.sh).
- **systemd таймеры:** [`deploy/systemd/`](../deploy/systemd) — еженедельная чистка `/opt/matricarmz/updates/`.
- **CI:** GitHub Actions для Windows installer (`.exe` + `latest.yml` + torrent). Релизный pipeline — `CLAUDE.md` §Release process.

## Где сейчас активная работа

- **Активной нитки сейчас нет.** Реорганизация памяти (раскол «открытое vs сделанное») ✅ завершена — план [`plans/_archive/memory-reorg-2026-06.md`](plans/_archive/memory-reorg-2026-06.md). Открытое — `PENDING_FOLLOWUPS.md`; сделанное — `COMPLETED.md`.
- Нитка **parts EAV → directory_parts** (Phase 1/2/3 + 3.5/3.6/3.7) **полностью на проде** — см. [`COMPLETED.md`](COMPLETED.md) §Детали. `/parts/*` отвечает 410, `directory_parts` — единственный источник.
- **🔴 Блокер:** Anthropic API geo-block — AI-фичи на проде выключены, ждёт VPS-forward-proxy. См. `PENDING_FOLLOWUPS.md`.

# MatricaRMZ — Codebase Map

Куратируемая карта где что живёт. **Не автогенерируется**, обновляется при значимых архитектурных изменениях. Цель — навигация от понятия к файлу за один взгляд, без широкой разведки на старте сессии.

Правила проекта для любого AI-агента — [`../AGENTS.md`](../AGENTS.md) (канон; `CLAUDE.md`/`GEMINI.md` — тонкие адаптеры к нему).

История релизов — `git log` + тело PR; навигация по сделанному — [`COMPLETED.md`](COMPLETED.md). Открытые задачи — [`PENDING_FOLLOWUPS.md`](PENDING_FOLLOWUPS.md). Грабли по симптомам — [`GOTCHAS.md`](GOTCHAS.md). Архитектура и правила — [`PROJECT_STATE.md`](PROJECT_STATE.md). Активная нитка — [`SESSION_HANDOFF.md`](SESSION_HANDOFF.md).

## Монорепо (pnpm workspaces)

| Пакет | Что | Когда сюда лезть |
|---|---|---|
| [`electron-app/`](../electron-app) | Electron + React UI клиент (renderer + main + preload) | UI, формы, главное окно, IPC, локальная SQLite |
| [`backend-api/`](../backend-api) | Express REST API + Drizzle ORM (PostgreSQL) | API endpoints, бизнес-логика, миграции, фоновые job'ы |
| [`shared/`](../shared) | Общие типы и pure-логика TS | Изменения видимые и UI и API, доменные правила (BOM, forecast, signatures) |
| [`web-admin/`](../web-admin) | Веб-админка (React, отдельно от Electron) | Админ-задачи через браузер |
| [`ledger/`](../ledger) | Encrypted event log + keyring (enc:v1/v2) | Шифрование sync-пакетов, ротация ключей |
| [`scripts/`](../scripts) | Корневые CLI: bump-version, release-ledger | Релизный процесс (см. `AGENTS.md` §Release) |
| [`deploy/`](../deploy) | nginx config + systemd units | Прод-конфигурация nginx / systemd таймеры |

## Backend (`backend-api/src/`)

| Домен | Файл(ы) | Когда сюда лезть |
|---|---|---|
| **BOM спецификация двигателя** | `services/warehouseBomService.ts`, `services/warehouseBomLineMeta.ts` | BOM-refactor (см. план `docs/plans/bom-refactor-2026-05.md`), variantGroup, parentLineKey, схема компонентов |
| **Номенклатура (Phase 1)** | `services/warehouseService.ts:1500–1700`, `scripts/auditPartsMirror.ts`, `scripts/fixPartsMirror.ts`, `scripts/migrateComponentTypeFromSpecJson.ts` | Component types, `directory_kind`, зеркало parts↔nomenclature, миграция Directories→Nomenclature |
| **Склад (3 регистра)** | `services/warehouseService.ts`, `services/warehouseLocationsService.ts` | Stock balances, документы прихода/расхода/перемещения, FK warehouse_location_id (Phase 2.x) |
| **Инструмент: позиция vs экземпляр** | `services/toolsService.ts` (экземпляры), `pages/ToolDetailsPage.tsx`, `scripts/migrateToolCatalogToNomenclature.ts` | Наименование живёт в номенклатуре, конкретная единица — в EAV-`tool`; выдаётся экземпляр. Граница — [`WAREHOUSE.md`](WAREHOUSE.md#инструмент-позиция--экземпляр-2026-08-13) |
| **Прогноз сборки** | `services/warehouseForecastService.ts` | Прогноз 7 дней, kit-варианты, edge cases (см. v1.22.0 блок A) |
| **Наряды** | `services/workOrderClosingService.ts`, `services/servicePricingService.ts` | 4 типа нарядов (Regular/Repair/Assembly/Manufacturing), подписи, ценообразование услуг |
| **Sync + Ledger** | `routes/sync.ts`, `routes/ledger.ts`, `services/masterdataSyncService.ts`, `services/syncPipelineSupervisorService.ts` | Синхронизация клиент↔сервер, ledger event log, supervisor (singleton на primary) |
| **AI** | `services/aiAgent*.ts`, `services/ai/claudeTools.ts` | AI-tools, learning, chat — **выключено на проде** ([Anthropic geo-block](PENDING_FOLLOWUPS.md#-блокер-anthropic-api-блокирует-рф-ip)) |
| **Auth / Users** | `routes/auth.ts`, `services/employeeAuthService.ts`, `services/userDeletionService.ts` | Логин сотрудников, GDPR-delete, refresh tokens |
| **Reports** | `routes/reports.ts`, пресеты в `shared/src/domain/reports.ts` | Отчёты (forecast, payroll, stock-audit), HTML-рендер для печати |
| **Reports (клиент, движок пресетов)** | `electron-app/src/main/services/reports/` (format / context / options / presets-по-доменам / dispatch / render; `reportPresetService.ts` — шим) | Пресет-отчёты клиента строятся локально из SQLite-реплики; новый пресет = builder в `presets/<домен>.ts` + case в `dispatch.ts` |
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
| **Печать наряда** | `utils/woPrintModel.ts` (+ `.test.ts`) | Две формы: сборочная и простая (обычный/ремонт/изготовление). Развилка по `workOrderKind`; зависимости — явный `WoPrintDeps`, не замыкание карточки |
| **Платежи контракта** | `utils/contractPaymentsStore.ts`, `components/EnginePaymentsTab.tsx`, `pages/ContractDetailsPage.tsx` | Единственная точка записи EAV `contract_payments` — read-modify-write. Писать атрибут напрямую из стейта нельзя: в него пишут и карточка контракта, и вкладка «Платежи» двигателя |
| **Справочники** | `pages/PartsPage.tsx`, `PartDetailsPage.tsx`, `ToolsPage.tsx`, `EngineBrandsPage.tsx`, `EmployeesPage.tsx`, `CounterpartiesPage.tsx`, `MasterdataPage` (экспорт из `AdminPage.tsx`), `SimpleMasterdataDetailsPage.tsx` | Детали, инструменты, изделия, марки, сотрудники, контрагенты. EAV-атрибуты регистрируются в `ensureAttributeDefs` внутри `SimpleMasterdataDetailsPage.tsx` |
| **Отчёты** | `pages/ReportsCatalogPage.tsx`, `ReportPresetPage.tsx`, `CustomReportsPage.tsx` | Каталог пресетов по темам, параметры, экспорт HTML/печать, «Мои отчёты» |
| **Админ** | `pages/AdminPage.tsx`, `SuperadminAuditPage.tsx`, `HistoryPage.tsx`, `ChangesPage.tsx` | Пользователи, аудит, история изменений. Экраны пользователей/аудита в браузере — свои файлы в `web-admin/src/ui/` |
| **Auth / Settings** | `pages/AuthPage.tsx`, `SettingsPage.tsx` | Логин, локальные настройки |
| **Рабочий стол / ярлыки** | `components/DesktopPane.tsx` (стол на экране чата: сетка, выделение, лассо, перенос), `shellV3/V3TabShell.tsx` (галстук `.v3-tab-desktop` на вкладке — тумблер ярлыка), `shellV2/ButtonPanel.tsx` (пункт «Добавить на Рабочий стол», закреп = закреп + ярлык), `components/TieIcon.tsx`, `HistoryPage.tsx` («Мой круг» = те же ярлыки) | Одна модель закладок — секция `desktop` в `ui_profile_json`; легаси «Быстрый запуск» (`pinnedShortcuts`) только читается ради одноразового переезда (`desktopMigrateQuickStart`). Раскладку считает домен (`desktopLayoutGrid`), не вёрстка; координата хранится в ячейках и при сужении стола НЕ переписывается. Размер плитки — место в личном распределении (`desktopUsageSteps`), счёт копится локально и уезжает в секцию `desktopUsage` свёрткой раз в 5 минут своим таймером. У компонента нет CSS-классов вовсе — зацепки смоуков только `data-desktop-*`, их держит `DesktopPane.guard.test.ts`. Обработчики читают стол из `desktopUiRef` (GOTCHAS M90) |
| **Сообщения оператору** | `shell/shellNotice.ts` (тип и сроки), `App.tsx` → `notifyOperator(text, tone)`, плашка `.v3-shell-notice` в `shellV3/V3TabShell.tsx` | Единственный канал коротких сообщений. Тон (`info`/`error`) приходит вызовом, не угадывается по тексту. Цепочку состояние → проп → JSX → CSS держит `shell/shellNotice.guard.test.ts`: она уже рвалась молча |
| **Главное окно / IPC** | `electron-app/src/main/`, `electron-app/src/preload/`, `electron-app/src/renderer/src/main.tsx` | Bootstrap, миграции SQLite, IPC bridges, autoupdater |

## Shared domain (`shared/src/domain/`)

| Файл | Что описывает |
|---|---|
| `warehouse.ts` | `resolveNomenclatureComponentTypeId` (приоритет column → specJson → эвристика), BOM-валидация, types для склада |
| `assemblyForecast.ts` | Pure-логика прогноза сборки (kit'ы, варианты, edge cases) |
| `workOrder.ts`, `workOrderSignatures.ts` | Типы нарядов, расчёт ФИО подписантов |
| `reports.ts` | Реестр пресетов отчётов, типы параметров |
| `releaseWelcome.ts` | `RELEASE_WELCOME_HISTORY` — текст для оператора при автообновлении |
| `desktop.ts`, `deepLinkRoute.ts` | Рабочий стол: санитайзер секции (`pos`, `shortcutsMigratedAt`, `desktopUsage` — «прививка»), тумблер/`put` с явным исходом, ключ ссылки для дедупа (`file:`/роут/`tab:`), переезд «Быстрого запуска». Сетка: `desktopTileMetrics` (шесть шагов размера) и `desktopLayoutGrid` (кто в какой ячейке при N колонках). Рейтинг: `desktopUsageBump`/`Add`/`Score`/`Steps` — затухание `0.5^(возраст/7)`, окно 30 дней, шаг по месту в распределении с правилом ничьих. Разбор ссылки приложения (`resolveDeepLinkRoute`) — здесь же, renderer реэкспортирует |
| `permissions.ts`, `signatureAccess.ts` | Роли и доступ к подписям |
| `part.ts`, `contract.ts`, `employees.ts`, `supplyRequest.ts` | Доменные типы остальных сущностей |
| `enums.ts`, `systemIds.ts`, `linkFieldRules.ts` | Перечисления, системные UUID, правила связей |

## БД

- **PostgreSQL 17 (prod, 17.8):** основная БД. Миграции — [`backend-api/drizzle/*.sql`](../backend-api/drizzle). Последняя merged: `0059_directory_parts_spec_columns.sql`. Drizzle schema: `backend-api/src/database/schema.ts`.
- **SQLite (клиент):** локальный кэш. Миграции — `electron-app/drizzle/`. Накат при старте Electron.
- **EAV (`attribute_values`):** атрибуты сущностей без DDL. Новые атрибуты регистрировать в `ensureAttributeDefs` (`SimpleMasterdataDetailsPage.tsx`). См. `AGENTS.md` §EAV.
- **Ledger (encrypted event log):** [`ledger/`](../ledger), keyring enc:v2 (multi-key, backward-compat с enc:v1).

## Deploy / Operations

- **Prod VPS:** только по SSH-алиасу `matricarmz` (хост, порт, пользователь и ключ — в `~/.ssh/config` машины; в репо их нет — `AGENTS.md` §«Публичный репозиторий — тоже recon-поверхность»). fail2ban aggressive — не долбить логином при ошибке, разбираться. См. `docs/OPERATIONS.md`, `docs/WINDOWS_DEVELOPMENT.md` §8.
- **Services (dual-instance):** `matricarmz-backend-primary.service` (`:3001`) — singleton job'ы; `matricarmz-backend-secondary.service` (`:3002`) — только API. nginx upstream.
- **nginx:** [`deploy/nginx/matricarmz-backend.conf`](../deploy/nginx/matricarmz-backend.conf) (catch-all `location /` + спец-блоки), выкат через [`deploy/nginx/install.sh`](../deploy/nginx/install.sh).
- **systemd:** [`deploy/systemd/`](../deploy/systemd) — шаблоны юнитов backend (`install-backend.sh` подставляет сервисного пользователя и путь к клону на сервере — в репо их нет) + еженедельная чистка `/opt/matricarmz/updates/`.
- **CI:** GitHub Actions для Windows installer (`.exe` + `latest.yml` + torrent). Релизный pipeline — `AGENTS.md` §Release process.

## Где сейчас активная работа

- **Референс-целостность при удалении** (диалог намерения + серверный гейт) — ✅ закрыта целиком, см. `COMPLETED.md`. Сборщик ссылок: `electron-app/src/main/services/entityService.ts` (`findAllIncomingReferences`) + серверное зеркало `backend-api/src/services/adminMasterdataService.ts` (`countExtendedIncomingReferences`); диалог — `ui/components/DeletionIntentDialog.tsx`.
- **Активная нитка: Матрица 4 + финиш EAV→erp_*** — план [`plans/matrica-v4-kickoff-2026-08.md`](plans/matrica-v4-kickoff-2026-08.md) (D-031). Трек A — Ф0/Ф1 в отдельном репо [`Matrica4`](https://github.com/Valstan/Matrica4) (см. AGENTS.md §«Два поколения»); трек B — миграция EAV→строгие таблицы здесь, этапами 0–6. Действует **EAV-freeze** (AGENTS.md §EAV).
- Нитка **parts EAV → directory_parts** (Phase 1/2/3 + 3.5/3.6/3.7) **полностью на проде** — см. [`COMPLETED.md`](COMPLETED.md) §Детали. `/parts/*` отвечает 410, `directory_parts` — единственный источник.
- **🔴 Блокер:** Anthropic API geo-block — AI-фичи на проде выключены, ждёт VPS-forward-proxy. См. `PENDING_FOLLOWUPS.md`.

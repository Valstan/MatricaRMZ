# Phase 3.8 — сузить sync-протокол номенклатуры (scope A, минимальный безопасный)

> **Статус:** 📋 план на согласовании. Создан 2026-06-17 (Claude Opus 4.8).
> **Решение владельца (2026-06-17):** **scope A — минимальный безопасный.** НЕ заводим `directory_parts` в синк-реестр, НЕ разворачиваем live-HTTP чтение спеков (Phase 3.7 WS1). Только: (1) снести пустой junction `erp_nomenclature_engine_brand` из sync-протокола/кода/схем; (2) разобрать и занулить 116 расхождений зеркала code/name.
> **Предшественники:** [`parts-nomenclature-phase3-7.md`](parts-nomenclature-phase3-7.md) (id-тождество, brand-links → `directory.brand_links_json`, live-HTTP spec-read), [`PENDING_FOLLOWUPS.md`](../../PENDING_FOLLOWUPS.md) §🟢 #6.
> **Что отложено (вариант B, НЕ делаем):** синк `directory_parts` на клиент + offline-чтение спеков из SQLite. Это разворот рабочего live-HTTP + расширение sync-протокола (риск порчи). Если когда-нибудь понадобится offline-specs — отдельная нитка с воркстримами.

## Grounded state (прод-снимок 2026-06-17, read-only)

| Метрика | Значение |
|---|---|
| `directory_parts` активных | 206 |
| `erp_nomenclature` активных | 716 (детали — подмножество; +двигатели/инструменты/узлы) |
| `erp_nomenclature_engine_brand` строк **всего** | **0** (таблица пуста) |
| Номенклатур без `directory_parts` по id | 455 |
| Зеркало code/name разошлось (id-тождество, оба активны) | 116 |
| из них: code-diff / name-diff | 115 / 2 |

## Почему junction пуст, но не «мёртвая таблица»

`erp_nomenclature_engine_brand` — **старый** механизм brand-links номенклатуры. С Phase 3.7 brand-links живут в `directory.brand_links_json` (id-тождество), junction перестали наполнять → 0 строк. Но он **широко проводён в живом коде** (возвращает пусто из-за 0 строк):

- `shared/src/sync/registry.ts` — entry `ErpNomenclatureEngineBrand` + `ERP_NOMENCLATURE_ENGINE_BRAND_FIELDS`.
- `shared/src/sync/tables.ts` — `SyncTableName.ErpNomenclatureEngineBrand`; `erpDto.ts` — `erpNomenclatureEngineBrandRowSchema`; ledger `LedgerTableName.ErpNomenclatureEngineBrand`.
- `backend-api/src/database/schema.ts:1158` — `erpNomenclatureEngineBrand` pgTable + индексы.
- `backend-api/src/services/warehouseBomService.ts:82` — `pickEngineNomenclatureIdForBrand`: junction-фолбэк **после** рабочего `defaultBrandId`-пути (фолбэк мёртв при 0 строк).
- `backend-api/src/services/warehouseService.ts` — `listWarehouseNomenclatureEngineBrands` (1776), `upsertWarehouseNomenclatureEngineBrand` (1798), `deleteWarehouseNomenclatureEngineBrand` (2102) — осиротевшие API (UI пишет brand-links через directory part-spec путь).
- `backend-api/src/services/sync/pullChangesSince.ts:59` + `ledgerReplayService.ts:67,118` — sync pull + ledger replay.
- `backend-api/src/services/ai/claudeTools.ts:333` — в allowed-set AI (read).
- `backend-api/src/scripts/warehouseThreeLevelDryRun.ts` — разовый скрипт (можно оставить/удалить).
- Клиент: `electron-app` client SQLite (drizzle/clientSchemaMigrations) — таблица создаётся при синке.

## WS-A1 — снести `erp_nomenclature_engine_brand` из протокола и кода

**Предусловие (гейт):** grep подтверждает 0 **живых** вызовов `list/upsert/deleteWarehouseNomenclatureEngineBrand` из routes/IPC (не считая определений). Если есть route/preload — удалить вместе.

Шаги (всё в одном PR, аддитивно-обратимо до DROP):
1. **Backend сервисы:** удалить `list/upsert/deleteWarehouseNomenclatureEngineBrand`; в `pickEngineNomenclatureIdForBrand` убрать junction-фолбэк (оставить `defaultBrandId`-путь); убрать case из `ledgerReplayService` + brand-чтение из junction (118-121) → читать brand из `directory.brand_links_json`/`defaultBrandId` если нужно (проверить, кто зовёт `ledgerReplay` brand-resolve); убрать из `pullChangesSince` маппинг; убрать из `claudeTools` allowed-set.
2. **Sync shared:** убрать entry из `registry.ts` (ENTRIES + FIELDS const + import), `SyncTableName.ErpNomenclatureEngineBrand` из `tables.ts`, schema из `erpDto.ts`, `LedgerTableName` запись. **⚠️ Sync-контракт-тест (`check-sync-contract` в CI)** — обновить ожидаемый набор таблиц.
3. **Schema:** убрать `erpNomenclatureEngineBrand` pgTable из `backend-api/src/database/schema.ts`; убрать из client schema (`electron-app/src/main/database/schema.ts` + `clientSchemaMigrations.ts`).
4. **Миграции:**
   - Server: `backend-api/drizzle/0064_drop_erp_nomenclature_engine_brand.sql` — `DROP TABLE IF EXISTS "erp_nomenclature_engine_brand";` (пусто → без потери данных) + запись idx 63 в `meta/_journal.json`. **Написана руками, НЕ `drizzle-kit generate`** — generate интерактивен и тащит постороннюю drift (`ai_chat_history` уже рассинхронен со snapshot); `migrate()` применяет по journal+SQL, snapshot для наката не нужен.
   - **Client SQLite: таблицу НЕ дропаем (осознанно).** `electron-app/src/main/services/migrations/clientSchemaMigrations.ts:~210` — raw-SQL rebuild `erp_engine_assembly_bom` читает junction в COALESCE-фолбэке; junction создаётся drizzle-SQL `0010`. DROP через новую drizzle-SQL сломал бы fresh-install (0010 создаёт → DROP убирает → rebuild падает `no such table`) — грабля двух миграторов [[client-schema-two-migrators]]. Убрали только ORM-декларацию (`schema.ts`) + весь клиентский код/IPC/preload/UI. Физическая пустая локальная таблица остаётся вестиджем (не синкается, UI не читает) — безвредна; снос отдельной ниткой при желании.
5. **UI:** убрана дублирующая секция «Применимые марки» (junction) из `NomenclatureDetailsPage`, оставлена «Применяемость (марки двигателей)» (`brand_links_json`). Решение владельца 2026-06-17.
6. **Гейты:** `shared`+`ledger` build → `-r typecheck` (5/5) → `-r lint` → backend test (261/261) → `check-sync-contract` → **CDP-smoke** (UI-правка: карточка номенклатуры рендерится, «Применяемость» на месте, «Применимые марки» нет).

## WS-A2 — реконсиляция code/name id-тождественных строк (прод-данные)

**⚠️ Исходное предположение опровергнуто прод-разведкой 2026-06-18.** 116 расхождений — НЕ простой бэкафилл `directory ← nomenclature`. Разбивка (read-only + dry-run на проде):

| Класс | n | Что |
|---|---|---|
| **A** | 93 | `directory.code` пуст, `nomenclature.code` = синтетика `DET-*`/`NM-*` → реального артикула нет нигде |
| **B** | 22 | `directory.code` = **реальный артикул** (`303-03-11`…), `nomenclature.code` = синтетика → из них **20 promotable**, **2 коллизии** (`d.code` уже занят другой `erp_nomenclature`-строкой) |
| name | 2 | `nomenclature` каноничен (directory = «комплек»/«Поршень»-обрезок) |

Наивный `directory.code ← nomenclature.code` **затёр бы 22 реальных артикула синтетикой** — отвергнут. Решение владельца (2026-06-17): **имена + продвинуть 22 (реально 20) артикула**.

**Критично — ledger:** `erp_nomenclature` синкается → сырой SQL-UPDATE кода не доедет до клиентов (нет ledger-события, seq не двинется, [[verify-stack-ledger-seq-drift]]). Код пишем через `recordSyncChanges` (ledger→index→PG). `directory_parts` — server-only (live-HTTP) → name правим прямым UPDATE без ledger. `erp_nomenclature_code_uq` — **глобально-уникальный** (incl. soft-deleted) → коллизии (incl. удалённые) пропускаем.

**Направление:** name → `directory.name ← nomenclature.name`; code → `nomenclature.code ← directory.code` (реальный артикул в синканный список) для не-коллидирующих B, где `nomenclature.code ~ ^(DET|NM)-`.

Скрипт: `backend-api/src/scripts/reconcileNomenclatureDirectoryCodeName.ts` (npm `warehouse:reconcile-code-name` / `:apply`), dry-run по умолчанию.

**Прод dry-run (2026-06-18, read-only, валидирован):** `divergent=116, names=2, code-promote=20, collisions=2` (skip: `3309-25-2` «Генератор с муфтой привода», `406-12-44` «Крышка люка»).

Шаги apply (прод): `pg_dump erp_nomenclature + directory_parts` → **явное подтверждение (G29)** → `--apply` → re-dry-run идемпотентен (names=0, promote=0). Row-counts в тело PR.

**Остаток → техдолг (PENDING):** 93 A (косметика, оба без артикула — не трогаем) + 2 коллизии (ручной мердж, класс «детали-двойники» / unique-index).

## Последовательность и прод-шаги

1. WS-A1 код → PR под гейтами → **показать diff → OK владельца → merge** (критичность: sync-протокол).
2. WS-A2 скрипт в том же или соседнем PR (код dry-run безопасен).
3. Релиз (`/reliz`): серверные пакеты собрать, **`db:migrate`** (DROP server table), артефакты updater, restart, smoke. Клиент получит client-SQLite DROP при старте после обновления.
4. **Прод-данные WS-A2:** dry-run → бэкап → подтверждение → `--apply` → row-counts (отдельный осознанный шаг, не в авто).

## Риски и откат
- **Sync-контракт:** удаление таблицы из реестра меняет набор синканных таблиц. Старые клиенты (до обновления) синкают таблицу, которой на сервере уже нет → сервер должен **толерантно** отдавать пусто/скип (она и так пустая). Проверить, что pull/replay не падает на отсутствующей таблице у не-обновлённого клиента. **Это главный риск-узел WS-A1 — заземлить до merge.**
- **Откат:** до DROP — чистый revert PR. После DROP — таблица пустая, пересоздаётся миграцией-реверсом при нужде (данных нет).
- **WS-A2:** аддитивный (заполнение пустого) + бэкап `directory_parts` → откат восстановлением дампа.

## Вне scope (вариант B, отложено)
- Синк `directory_parts` на клиент, offline-чтение спеков из client SQLite, снос code/name-зеркала целиком. Разворот live-HTTP (Phase 3.7 WS1) — отдельная нитка, если понадобится offline.

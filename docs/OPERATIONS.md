# MatricaRMZ Operations

Операционный справочник для разработки и поддержки: где что лежит, как запустить, какие ENV/логи критичны, и какие инварианты нельзя ломать.

## 1) Состав репозитория
- Корень: `/home/valstan/MatricaRMZ`
- Пакеты: `backend-api/`, `electron-app/`, `shared/`, `web-admin/`, `docs/`, `scripts/`

## 2) Ключевые точки входа

### Backend API
- Код: `backend-api/src`
- Точка входа: `backend-api/src/index.ts`
- Сборка: `backend-api/dist/index.js`
- systemd сервис: `matricarmz-backend.service`
- Роуты: `backend-api/src/routes/*`
- Ledger: `backend-api/ledger/`
- Складской backend-контур: `backend-api/src/routes/warehouse.ts`, `backend-api/src/services/warehouseService.ts`

### Electron клиент
- Main: `electron-app/src/main`
- Preload: `electron-app/src/preload/index.ts`
- Renderer UI: `electron-app/src/renderer/src/ui`
- Sync/Update сервисы: `electron-app/src/main/services/syncService.ts`, `electron-app/src/main/services/updateService.ts`
- NSIS настройка установщика: `electron-app/installer/installer.nsh`
- Складские экраны: `electron-app/src/renderer/src/ui/pages/Stock*.tsx`, `Nomenclature*.tsx`

### Shared
- Доменные модели/типы: `shared/src/domain/*`
- Sync DTO/таблицы: `shared/src/sync/dto.ts`, `shared/src/sync/tables.ts`
- IPC контракт: `shared/src/ipc/types.ts`

## 3) Быстрый старт разработки

Из корня репозитория:

```bash
pnpm install
pnpm --filter @matricarmz/shared build
pnpm --filter @matricarmz/backend-api db:migrate
pnpm --filter @matricarmz/backend-api dev
pnpm --filter @matricarmz/electron-app dev
```

Для Windows 11 можно использовать подготовленные root-команды:

```powershell
corepack pnpm run setup:dev
corepack pnpm run db:migrate
corepack pnpm run dev:backend
corepack pnpm run dev:electron
```

## 4) Ключевые ENV

### Backend
- `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- `MATRICA_JWT_SECRET`
- `MATRICA_LEDGER_DIR`
- `MATRICA_LEDGER_DATA_KEY`
- `MATRICA_LOGS_DIR`
- `PORT`, `HOST`
- `SYNC_V2_ENFORCE`
- `MATRICA_SYNC_AUTOHEAL_ENABLED`
- `MATRICA_SYNC_AUTOHEAL_COOLDOWN_MS`
- `MATRICA_SYNC_DRIFT_THRESHOLD`
- `MATRICA_SYNC_PULL_ADAPTIVE_ENABLED`

### Client / Update
- `MATRICA_API_URL`
- `MATRICA_LEDGER_E2E`
- `MATRICA_UPDATE_YANDEX_PUBLIC_KEY`
- `MATRICA_UPDATE_YANDEX_BASE_PATH`
- `MATRICA_UPDATE_GITHUB_REPO`

### Release
- `MATRICA_LEDGER_RELEASE_TOKEN`
- `MATRICA_LEDGER_RELEASE_NOTES`
- `MATRICA_RELEASE_ASSET_WAIT_MS`
- `MATRICA_RELEASE_ASSET_WAIT_ATTEMPTS`

## 5) Логи и диагностика
- Клиент локально: `app.getPath('userData')/matricarmz.log`
- Updater helper лог: `app.getPath('userData')/matricarmz-updater.log`
- Серверные логи клиента: `backend-api/logs/client-YYYY-MM-DD.log`
- Базовая директория серверных логов: `MATRICA_LOGS_DIR` (по умолчанию `backend-api/logs`)

## 6) Инварианты, которые нельзя нарушать
- Синхронизация только через ledger: `POST /ledger/tx/submit`, `GET /ledger/state/changes`.
- Любые серверные изменения sync-таблиц должны идти через ledger pipeline (`recordSyncChanges()`/ledger API).
- `clientId` должен быть стабильным на клиенте.
- Временные поля в ms должны храниться как `bigint`.
- Релизы для автообновления публикуются в ledger с валидными `version/fileName/size/sha256`.

## 7) Что смотреть в первую очередь при новой сессии
1. `docs/README.md`
2. `docs/OPERATIONS.md` (этот файл)
3. В зависимости от задачи: `WAREHOUSE.md`, `RELEASE.md`, `REPORTS.md`, `BLOCKCHAIN.md`, `TROUBLESHOOTING.md`
4. Политика поддержки документации: `docs/DOCUMENTATION_POLICY.md`

## 8) Базовый срез актуальности
Документация синхронизирована по изменениям актуального рабочего контура, в том числе:
- усиленный update-flow (торрент/LAN/Yandex/GitHub + ручной fallback),
- проверка целостности установщика с докачкой/перезакачкой,
- обновленные пресеты и фильтры отчетов для контрактов/бухгалтерии,
- выделенный складской контур с lookup API, типизированными warehouse DTO и сценарными экранами документов/остатков/инвентаризации.

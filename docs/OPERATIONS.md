# MatricaRMZ Operations

Операционный справочник для разработки и поддержки: где что лежит, как запустить, какие ENV/логи критичны, и какие инварианты нельзя ломать.

## 1) Состав репозитория
- Корень: `~/MatricaRMZ`
- Пакеты: `backend-api/`, `electron-app/`, `shared/`, `web-admin/`, `docs/`, `scripts/`

### Управление прод-сервером (напоминание для ИИ-агентов)
- Прод-VPS обслуживается **только через SSH** в терминале: Host-алиас из `~/.ssh/config` (на Windows — `%USERPROFILE%\.ssh\config`, обычно `matricarmz`). Не рассчитывайте на отдельный MCP-сервер в этом репозитории.
- После push в GitHub типичный контур деплоя: `ssh matricarmz` → `cd ~/MatricaRMZ` → `git pull`, сборка/миграции/рестарт сервисов по задаче (подробнее — AGENTS.md §Release process, `docs/TROUBLESHOOTING.md`). Деплой — отдельный осознанный шаг (`/reliz`), не часть закрытия сессии.

## 2) Ключевые точки входа

### Backend API
- Код: `backend-api/src`
- Точка входа: `backend-api/src/index.ts`
- Сборка: `backend-api/dist/index.js`
- systemd сервисы (prod):
  - `matricarmz-backend-primary.service` (`127.0.0.1:3001`) — API + singleton background jobs
  - `matricarmz-backend-secondary.service` (`127.0.0.1:3002`) — только API (без background jobs)
- nginx upstream: `127.0.0.1:3001` + `127.0.0.1:3002`
- Роуты: `backend-api/src/routes/*`
- Журнал изменений: таблицы `ledger_tx_index` + `release_registry` в PostgreSQL (цепочка блоков снята 2026-09, см. `docs/plans/ledger-journal-in-pg-2026-09.md`)
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
- `MATRICA_LOGS_DIR`
- `PORT`, `HOST`
- `MATRICA_INSTANCE_PORT`, `MATRICA_INSTANCE_ROLE`
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

### Off-site бэкап
- `YANDEX_DISK_TOKEN`, `YANDEX_DISK_BASE_PATH`
- `BACKUP_ENCRYPTION_PUBLIC_KEY_FILE` (или `BACKUP_ENCRYPTION_PUBLIC_KEY`) — дамп, см. §9
- `BACKUP_SNAPSHOT_KEY` — снимок, см. §9

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
- Синхронизация только через `POST /ledger/tx/submit` и `GET /ledger/state/changes` (имена маршрутов исторические: цепочки блоков нет с 2026-09, за ними — журнал в PG).
- Любые серверные изменения sync-таблиц должны идти через `writeSyncChanges()` / `recordSyncChanges()`: строка без номера журнала невидима инкрементальному pull.
- `clientId` должен быть стабильным на клиенте.
- Временные поля в ms должны храниться как `bigint`.
- Релизы для автообновления публикуются в `release_registry` (`POST /ledger/releases/publish`) с валидными `version/fileName/size/sha256`.
- В dual-backend контуре singleton background jobs (`sync pipeline supervisor`, `critical events notifier`, schedulers) запускаются только на `primary` (`MATRICA_INSTANCE_ROLE` не должен быть `secondary/readonly/worker`).

## 7) Что смотреть в первую очередь при новой сессии
1. `docs/README.md` (в т.ч. блок «Напоминание для ИИ-агентов: прод-сервер»)
2. `docs/OPERATIONS.md` (этот файл)
3. Правило Cursor для агента: `.cursor/rules/production-ssh.mdc` (прод только через SSH)
4. В зависимости от задачи: `WAREHOUSE.md`, `RELEASE.md`, `REPORTS.md`, `BLOCKCHAIN.md`, `TROUBLESHOOTING.md`
5. Политика поддержки документации: `docs/DOCUMENTATION_POLICY.md`

## 8) Базовый срез актуальности
Документация синхронизирована по изменениям актуального рабочего контура, в том числе:
- усиленный update-flow (торрент/LAN/Yandex/GitHub + ручной fallback),
- проверка целостности установщика с докачкой/перезакачкой,
- обновленные пресеты и фильтры отчетов для контрактов/бухгалтерии,
- выделенный складской контур с lookup API, типизированными warehouse DTO и сценарными экранами документов/остатков/инвентаризации.

## 9) Off-site бэкап: шифрование и восстановление

Ночной бэкап (`backup:nightly`, systemd-таймер на проде) кладёт на Яндекс.Диск в `<YANDEX_DISK_BASE_PATH>/base_reserv`:

| Файл | Что это | Шифрование |
|---|---|---|
| `YYYY-MM-DD.dump.enc` | `pg_dump --format=custom` всей БД — артефакт восстановления | ✅ RSA-4096 + AES-256-GCM |
| `YYYY-MM-DD.sqlite.enc` | срез EAV для режима «просмотр бэкапа» в клиенте | ✅ AES-256-GCM, кадрами по 4 МБ |

**Схема ключей (директива brain `2026-08-19-three-zero-cost-fixes-before-the-onprem-move`).** На сервере лежит **только публичный** ключ (`BACKUP_ENCRYPTION_PUBLIC_KEY_FILE=/opt/matricarmz/secrets/backup-public.pem`): сервер умеет зашифровать и не умеет расшифровать. Приватная половина — **вне сервера**, на PC40 в `%USERPROFILE%\.matricarmz-keys\backup-private.pem` (там же, где Android-keystore) + офлайн-копия. Украденный `YANDEX_DISK_TOKEN` без приватного ключа даёт только шифротекст.

**Открытого фолбэка нет:** если публичный ключ не настроен, `backup:nightly` падает до `pg_dump` с явной ошибкой. Молча деградировать в открытый дамп — ровно та беда, от которой это защищает.

**Восстановление** (на машине с приватным ключом, НЕ на проде):

```bash
corepack pnpm -F @matricarmz/backend-api backup:decrypt \
  --in 2026-08-19.dump.enc --out 2026-08-19.dump \
  --key "$USERPROFILE/.matricarmz-keys/backup-private.pem"
pg_restore --clean --if-exists --no-owner --no-privileges -d <база> 2026-08-19.dump
```

Скрипт печатает, начинается ли расшифрованный файл сигнатурой `PGDMP` — это отличает «байты расшифровались» от «дамп действительно восстановим».

### Снимок (`.sqlite.enc`) — симметричный ключ и расшифровывающая отдача

У снимка задача другая: его **читает живая фича клиента** «просмотр бэкапа», то есть расшифровать должен уметь сервер. Поэтому здесь симметричный `BACKUP_SNAPSHOT_KEY` (32 байта в base64) в прод-`.env`. Модель угроз честная: утечка одного `YANDEX_DISK_TOKEN` больше не даёт открытый текст; компрометация самого сервера — даёт, и это не лечится ключом, который серверу нужен для работы.

**Путь клиента не изменился и парк обновлять не потребовалось.** `GET /backups/nightly/:date/url` теперь отдаёт ссылку на свой маршрут `GET /backups/nightly/:date/download?t=<токен>` вместо прямой яндексовой; клиент просто качает выданный URL. Маршрут отдачи зарегистрирован **до** `requireAuth` (клиент качает голым `net.fetch` без заголовков) и защищён подписанным HMAC-токеном на 5 минут, привязанным к дате снимка. Легаси-снимки (открытые `.sqlite`, доживающие ротацию) по-прежнему отдаются прямой ссылкой — развилка по факту наличия `.enc`.

**Формат** — `backend-api/src/services/snapshotCrypto.ts`: AES-256-GCM **кадрами по 4 МБ**, у каждого кадра свой тег, AAD = номер кадра + флаг финального. Один большой GCM-блоб не годится: тег проверился бы только после последнего байта, и прокси пришлось бы либо буферизовать 150 МБ на небольшой VPS, либо отдать клиенту непроверенные байты и вручить молча битую базу. Номер кадра в AAD запрещает перестановку и повтор кадров, флаг финального делает обрезку ошибкой, а не «файлом поменьше».

**Формат конверта дампа** — `backend-api/src/services/backupCrypto.ts`: магия `MRMZBK` + версия, RSA-OAEP(SHA-256) обёртка над случайным AES-ключом, поток AES-256-GCM, 16-байтная метка целостности в хвосте. Подмена файла или чужой ключ ловятся на `final()`, а не молча.

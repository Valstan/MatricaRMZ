# MatricaRMZ — карта путей и мест хранения

Цель: быстрый справочник “где что лежит” для сопровождения, релизов и поддержки.
Поддерживать актуальность при изменениях структуры и процессов.

## Репозиторий и базовые файлы
- Репозиторий: `/home/valstan/MatricaRMZ`
- Клиентская версия: `VERSION` + `electron-app/package.json` (должны совпадать)
- Backend версия: `backend-api/package.json`
- Release инструкции: `RELEASE.md`
- Быстрый старт и setup: `QUICK_START.md`, `README_SETUP.md`
- Политики безопасности: `SECURITY.md`
- Release notes/процедуры: `RELEASE.md`, `RELEASE.md`
- Общий status: `docs/SESSION_STATUS.md`

## Монорепо (верхний уровень)
- `backend-api/` — сервер (PostgreSQL)
- `electron-app/` — клиент (Electron)
- `shared/` — общие типы/DTO/enum/IPC
- `docs/` — документация и справочники
- `scripts/` — релизные и служебные скрипты

## Backend API (PostgreSQL)
- Код: `backend-api/src`
- Точка входа: `backend-api/src/index.ts`
- Сборка: `backend-api/dist/index.js`
- systemd сервис: `matricarmz-backend.service`
- Миграции: `backend-api/drizzle/*.sql`
- Конфиг миграций: `backend-api/drizzle.config.ts`
- БД схема: `backend-api/src/database/schema.ts`
- Миграции/seed:
  - `pnpm --filter @matricarmz/backend-api db:migrate`
  - `pnpm --filter @matricarmz/backend-api perm:seed`
- Auth/permissions: `backend-api/src/auth/*`
- API роуты: `backend-api/src/routes/*`
- Логи сервера: `backend-api/src/utils/logger.ts`

## Electron клиент
- Main процесс: `electron-app/src/main`
- Renderer (UI): `electron-app/src/renderer`
- Preload: `electron-app/src/preload/index.ts`
- IPC регистрация: `electron-app/src/main/ipc/registerIpc.ts`
- Автообновление: `electron-app/src/main/services/updateService.ts`
- SQLite схема: `electron-app/src/main/database/schema.ts`
- SQLite миграции: `electron-app/drizzle/*.sql`

## Shared (общие типы)
- Типы и домены: `shared/src/domain/*`
- IPC типы: `shared/src/ipc/types.ts`
- Sync DTO и таблицы: `shared/src/sync/dto.ts`, `shared/src/sync/tables.ts`
- Экспорт всего: `shared/src/index.ts`

## Логи
- Клиент локально: `app.getPath('userData')/matricarmz.log`
  - Пишется из `electron-app/src/main/ipc/registerIpc.ts`
  - Sync пишет из `electron-app/src/main/services/syncService.ts`
- Логи обновлятора: `app.getPath('userData')/matricarmz-updater.log`
  - Пишется из `electron-app/src/main/services/updateService.ts`
- Клиент → сервер:
  - Endpoint: `POST /logs/client`
  - Путь: `backend-api/logs/client-YYYY-MM-DD.log`
  - Базовая папка: `MATRICA_LOGS_DIR` (по умолчанию `backend-api/logs`)
  - Код: `backend-api/src/routes/logs.ts`
- Логирование клиента (буфер + отправка):
  - `electron-app/src/main/services/logService.ts`

## Файлы и хранилище
- Серверный модуль: `backend-api/src/routes/files.ts`
- Yandex.Disk сервис: `backend-api/src/services/yandexDisk.ts`
- Клиентский upload/download: `electron-app/src/main/services/fileService.ts`
- Тип ссылки на файл: `shared/src/domain/fileStorage.ts`

## Обновления клиента
- Проверка/установка при запуске: `electron-app/src/main/services/updateService.ts`
- IPC обновлений: `electron-app/src/main/ipc/register/update.ts`
- Release info: `release-info.json` внутри сборки (формируется GitHub Actions)

## Синхронизация данных
- Сервер: `backend-api/src/services/sync/*`
- Клиент: `electron-app/src/main/services/syncService.ts`
- Таблицы синка: `shared/src/sync/tables.ts`
- Sync state на сервере: `backend-api/src/database/schema.ts` (`sync_state`, `change_log`)
- Sync state на клиенте: `electron-app/src/main/database/schema.ts`

## Основные UI‑модули (Renderer)
- Корневой UI: `electron-app/src/renderer/src/ui/App.tsx`
- Навигация: `electron-app/src/renderer/src/ui/layout/Tabs.tsx`
- Страницы: `electron-app/src/renderer/src/ui/pages/*`
  - Двигатели: `EnginesPage.tsx`, `EngineDetailsPage.tsx`
  - Заявки: `SupplyRequestsPage.tsx`, `SupplyRequestDetailsPage.tsx`
  - Детали: `PartsPage.tsx`, `PartDetailsPage.tsx`
  - Отчёты: `ReportsPage.tsx`
  - Админка: `AdminPage.tsx`
  - Изменения: `ChangesPage.tsx`
  - Синхронизация: `SyncPage.tsx`
  - Настройки: `SettingsPage.tsx`
  - Вход: `AuthPage.tsx`

## Модули backend (routes)
- Auth: `backend-api/src/routes/auth.ts`
- Sync: `backend-api/src/routes/sync.ts`
- Админ пользователи: `backend-api/src/routes/adminUsers.ts`
- Файлы: `backend-api/src/routes/files.ts`
- Логи: `backend-api/src/routes/logs.ts`
- Бэкапы: `backend-api/src/routes/backups.ts`
- Детали: `backend-api/src/routes/parts.ts`
- Изменения: `backend-api/src/routes/changes.ts`
- Чат: `backend-api/src/routes/chat.ts`

## Чат
- Backend: `backend-api/src/routes/chat.ts`
- Клиент (service): `electron-app/src/main/services/chatService.ts`
- UI: `electron-app/src/renderer/src/ui/components/ChatPanel.tsx`
- Таблицы: `chat_messages`, `chat_reads`, `user_presence`

## Бэкапы
- Backend nightly: `backend-api/src/scripts/nightlyBackup.ts`
- Клиент IPC: `electron-app/src/main/ipc/register/backups.ts`

## Релизы и версия
- Клиент релиз скрипт: `scripts/bump-version.mjs`
- Backend релиз скрипт: `scripts/bump-backend-version.mjs`
- Авто‑релиз: `scripts/release-auto.mjs` (`pnpm release:auto`)

## Полезные карты
- `docs/SESSION_STATUS.md` — статус, проблемы, VPS заметки
- `docs/REQUIREMENTS_EXTRACTED.md` — вытянутые требования
- `docs/ROADMAP.md` — roadmap разработки

## IPC (каналы и где регистрируются)
- Регистрация каналов: `electron-app/src/main/ipc/registerIpc.ts`
- Подмодули:
  - `electron-app/src/main/ipc/register/authAndSync.ts`
  - `electron-app/src/main/ipc/register/enginesOpsAudit.ts`
  - `electron-app/src/main/ipc/register/parts.ts`
  - `electron-app/src/main/ipc/register/supplyRequests.ts`
  - `electron-app/src/main/ipc/register/admin.ts`
  - `electron-app/src/main/ipc/register/changes.ts`
  - `electron-app/src/main/ipc/register/files.ts`
  - `electron-app/src/main/ipc/register/logging.ts`
  - `electron-app/src/main/ipc/register/update.ts`
  - `electron-app/src/main/ipc/register/backups.ts`
  - `electron-app/src/main/ipc/register/chat.ts`
- Типы IPC (контракт): `shared/src/ipc/types.ts`

## Permissions (права доступа)
- Backend список прав: `backend-api/src/auth/permissions.ts`
- UI каталог прав (RU подписи): `shared/src/domain/permissions.ts`
- UI‑гейт по правам: `electron-app/src/renderer/src/ui/auth/permissions.ts`

## ENV переменные (ключевые)
- Backend:
  - `MATRICA_JWT_SECRET` (auth)
  - `YANDEX_DISK_TOKEN`, `YANDEX_DISK_BASE_PATH` (файлы)
  - `MATRICA_LOGS_DIR` (логи клиента на сервере)
  - `PORT`, `HOST` (http)
- Client:
  - `MATRICA_API_URL` (URL backend)
  - `MATRICA_UPDATE_YANDEX_PUBLIC_KEY`, `MATRICA_UPDATE_YANDEX_BASE_PATH` (auto‑update)

## Артефакты сборки
- Electron (prod):
  - `electron-app/dist/main` (main process)
  - `electron-app/dist/preload`
  - `dist/renderer` (renderer bundle)
- Backend:
  - `backend-api/dist`

## Troubleshooting checklist (куда смотреть)
- Sync ошибки: `backend-api/logs/client-YYYY-MM-DD.log` + `matricarmz.log` у клиента
- Ошибки auth: `backend-api/src/auth/*` и `/auth/*` роуты
- Ошибки обновления клиента: `electron-app/src/main/services/updateService.ts`
- Ошибки файлов (Yandex): `backend-api/src/routes/files.ts` и `backend-api/src/services/yandexDisk.ts`


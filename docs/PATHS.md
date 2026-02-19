 # MatricaRMZ — справочник путей
 
Единый источник “где что лежит” и ключевые точки входа.
Для старта сессии см. `docs/start_session.md`.
 
 ## Репозиторий
 - Корень: `/home/valstan/MatricaRMZ`
 - Пакеты: `backend-api/`, `electron-app/`, `shared/`, `docs/`, `scripts/`
 
 ## Backend API
 - Код: `backend-api/src`
 - Точка входа: `backend-api/src/index.ts`
 - Сборка: `backend-api/dist/index.js`
 - Сервис: `matricarmz-backend.service`
 - Схема БД: `backend-api/src/database/schema.ts`
 - Миграции: `backend-api/drizzle/*.sql`
 - Ledger: `backend-api/ledger/`
 - Роуты:
   - auth: `backend-api/src/routes/auth.ts`
   - ledger: `backend-api/src/routes/ledger.ts`
   - diagnostics: `backend-api/src/routes/diagnostics.ts`
   - admin: `backend-api/src/routes/adminUsers.ts`
   - files: `backend-api/src/routes/files.ts`
   - logs: `backend-api/src/routes/logs.ts`
   - chat: `backend-api/src/routes/chat.ts`
   - sync (legacy, 410): `backend-api/src/routes/sync.ts`
 
 ## Electron клиент
 - Main: `electron-app/src/main`
 - Renderer (UI): `electron-app/src/renderer`
 - Preload: `electron-app/src/preload/index.ts`
 - Sync: `electron-app/src/main/services/syncService.ts`
 - Обновления: `electron-app/src/main/services/updateService.ts`
 - Файлы: `electron-app/src/main/services/fileService.ts`
 - Логи: `electron-app/src/main/services/logService.ts`
 - SQLite схема: `electron-app/src/main/database/schema.ts`
 
 ## Shared
 - Доменные типы: `shared/src/domain/*`
 - Sync DTO/таблицы: `shared/src/sync/dto.ts`, `shared/src/sync/tables.ts`
 - IPC контракт: `shared/src/ipc/types.ts`
 
 ## Логи
 - Клиент локально: `app.getPath('userData')/matricarmz.log`
 - Клиент → сервер: `backend-api/logs/client-YYYY-MM-DD.log`
 - Базовая папка логов сервера: `MATRICA_LOGS_DIR` (по умолчанию `backend-api/logs`)
 
 ## Синхронизация (ledger-only)
 - Push: `POST /ledger/tx/submit`
 - Pull: `GET /ledger/state/changes?since=...`
 - Legacy `/sync/*` отключены (410)

## Правило записи в ledger
- Любые серверные изменения в sync-таблицах идут через ledger (`recordSyncChanges()` или `/ledger/tx/submit`).
- Нельзя писать в sync-таблицы напрямую (иначе клиент может потерять данные).
 
 ## ENV (ключевые)
 - Backend:
   - Учётные данные PostgreSQL: `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` — хранятся в `backend-api/.env` (подхватываются через `EnvironmentFile` в systemd). Миграции нужно запускать от пользователя, которому принадлежат таблицы (обычно тот же `PGUSER`); иначе возможна ошибка «must be owner of table». См. `docs/TROUBLESHOOTING.md` (раздел про миграции и владельца БД).
   - `MATRICA_JWT_SECRET`
   - `MATRICA_LEDGER_DIR`
   - `MATRICA_LEDGER_DATA_KEY`
   - `MATRICA_LOGS_DIR`
  - `MATRICA_TELEGRAM_BOT_TOKEN`
   - `PORT`, `HOST`
 - Client:
   - `MATRICA_API_URL`
   - `MATRICA_LEDGER_E2E=1` (end‑to‑end шифрование `meta_json`/`payload_json`)
 - AI/Ollama (если включено):
   - `OLLAMA_BASE_URL`, `OLLAMA_MODEL_CHAT`, `OLLAMA_MODEL_ANALYTICS`
   - `OLLAMA_TIMEOUT_CHAT_MS`, `OLLAMA_TIMEOUT_ANALYTICS_MS`
   - `AI_RAG_ENABLED`, `AI_RAG_TOP_K`, `AI_RAG_LOOKBACK_HOURS`
 
## Полезные документы
- Старт сессии: `docs/start_session.md`
 - Troubleshooting: `docs/TROUBLESHOOTING.md`
 - Релизы/обновления: `docs/RELEASE.md`
 - Безопасность: `docs/SECURITY.md`

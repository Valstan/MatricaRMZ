 # start_session
 
Сессию назови "МАТРИЦА РМЗ 9 февраля" (вместо 9 февраля поставь текущую дату)
 
 Сессия разработки MatricaRMZ (VPS, sudo без пароля). Репозиторий: `/home/valstan/MatricaRMZ`.
 Документация: `/home/valstan/MatricaRMZ/docs`.
 
 Ключевые факты:
 - Монорепо: `electron-app` (Electron + SQLite), `backend-api` (Express + PostgreSQL), `shared` (общие типы/DTO).
 - Синхронизация только через ledger: `POST /ledger/tx/submit`, `GET /ledger/state/changes`. `/sync/*` отключены (410).
 - Любые серверные записи в sync‑таблицы должны проходить через ledger: `recordSyncChanges()` или `/ledger/tx/submit`.
 - При добавлении новой sync‑таблицы: обнови `SyncTableName`, `LedgerTableName`, `syncRowSchemaByTable`, `TABLE_MAP`, `SYNC_TABLES`.
 - Ledger в `backend-api/ledger/`, возможно шифрование payload (ключ `MATRICA_LEDGER_DATA_KEY`).
 - Время хранится в миллисекундах, в БД все timestamp‑поля должны быть `bigint`.
 - Авторизация обязательна (JWT + refresh). `MATRICA_JWT_SECRET` обязателен в env.
 - Логи клиента: `backend-api/logs/client-YYYY-MM-DD.log` и локально `matricarmz.log`.
 - systemd backend: `matricarmz-backend.service` → `/home/valstan/MatricaRMZ/backend-api/dist/index.js`.
 
 ENV (ключевые):
 - Backend: `MATRICA_JWT_SECRET`, `MATRICA_LEDGER_DIR`, `MATRICA_LEDGER_DATA_KEY`, `MATRICA_LOGS_DIR`, `PORT`, `HOST`.
 - Client: `MATRICA_API_URL`, `MATRICA_LEDGER_E2E`.
 - AI/Ollama (если включено): `OLLAMA_BASE_URL`, `OLLAMA_MODEL_CHAT`, `OLLAMA_MODEL_ANALYTICS`.
 
 Быстрый старт (если нужно):
 - `pnpm install` в корне.
 - Backend: `pnpm --filter @matricarmz/backend-api db:migrate`, `pnpm --filter @matricarmz/backend-api dev`.
 - Client: `pnpm --filter @matricarmz/electron-app dev`.
 
 Справочники:
 - Пути/ENV/логи: `docs/PATHS.md`.
 - Troubleshooting: `docs/TROUBLESHOOTING.md`.
 - Релизы: `docs/RELEASE.md`.
 
 Ожидай задание. Если нужно уточнение — сначала прочитай `docs/PATHS.md`.

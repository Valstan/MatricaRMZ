# MatricaRMZ (Матрица РМЗ)

Монорепо приложения **MatricaRMZ**:
- **Electron клиент** (локальная SQLite + UI)
- **Backend API** (PostgreSQL + sync push/pull + auth)
- **shared** (общие типы/контракты/доменные модели)

## Структура репозитория
- `electron-app/` — Electron (main/preload/renderer), локальная SQLite, синхронизация и UI.
- `backend-api/` — Express API, PostgreSQL, авторизация (JWT+refresh), админка пользователей/прав.
- `shared/` — общие DTO/типы и доменные модели (включая sync-контракт).
- `docs/` — справка по разработке/эксплуатации.

## Быстрый старт (разработка)
См. [`QUICK_START.md`](QUICK_START.md).

## Установка и запуск на VPS (прод)
См. [`README_SETUP.md`](README_SETUP.md).

## Документация
- **Статус проекта**: [`docs/SESSION_STATUS.md`](docs/SESSION_STATUS.md)
- **Troubleshooting (sync/деплой)**: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)
- **Roadmap**: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- **Релизы**: [`RELEASE.md`](RELEASE.md)
- **Секреты/безопасность**: [`SECURITY.md`](SECURITY.md)
- **Блокчейн‑слой (ledger)**: [`docs/BLOCKCHAIN.md`](docs/BLOCKCHAIN.md)

## Ключевые принципы
- **Секреты** (`.env`, токены, пароли) **не храним в репозитории** — см. [`SECURITY.md`](SECURITY.md).
- Клиент хранит данные локально в SQLite и синхронизирует изменения через `/sync/push` и `/sync/pull`.
- `clientId` клиента должен быть **стабильным** (хранится в локальном `sync_state`), чтобы на сервере не плодились записи `sync_state` и чтобы диагностика была понятной.
- Релиз клиента фиксируется в ledger (version/fileName/size/SHA256) — без этого клиент не установит обновление.



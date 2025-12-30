# Быстрый старт (разработка) MatricaRMZ

Цель: быстро поднять проект локально и проверить базовый сценарий (auth + sync).

## Требования
- Node.js (v22+)
- pnpm (см. `packageManager` в корневом `package.json`)
- PostgreSQL (для backend)

## 1) Установка зависимостей
В корне монорепо:

```bash
cd /home/valstan/MatricaRMZ
pnpm install
```

## 2) Backend API (локально)
1) Настроить окружение (пример):
- `backend-api/.env` (на сервере/локально, не коммитить; см. `backend-api/env.example.txt`)

2) Миграции:

```bash
cd /home/valstan/MatricaRMZ/backend-api
pnpm run db:migrate
```

3) Запуск:

```bash
pnpm run dev
```

Проверка:

```bash
curl -sS http://127.0.0.1:3001/health
```

## 3) Electron клиент (dev)

```bash
cd /home/valstan/MatricaRMZ/electron-app
pnpm run dev
```

Важно:
- API URL можно задать `MATRICA_API_URL=...` при запуске.
- `clientId` для sync **стабильный** (хранится в локальном `sync_state`), поэтому серверный `sync_state` не раздувается от каждого запуска.

## 4) Быстрая проверка sync
- В клиенте: выполнить вход (логин обязателен), затем “Синхронизировать сейчас”.
- Если что-то пошло не так — см. [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).
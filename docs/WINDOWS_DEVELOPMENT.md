# Windows 11 Development

Короткий рабочий контур для локальной разработки на Windows 11 с доступом к VPS через Cursor MCP.

## 1. Базовый стек

- Рекомендуемый Node.js: `22.x LTS`, чтобы совпадать с VPS (`v22.22.0`).
- Пакетный менеджер: `pnpm@10.26.1` через `corepack`.
- IDE: Cursor / VS Code.
- Удаленный доступ к серверу: MCP-сервер `vps-matricarmz` в Cursor.

## 2. Первый запуск

Из корня репозитория:

```powershell
corepack pnpm run setup:dev
```

Что делает команда:

- активирует `pnpm` через `corepack`,
- ставит зависимости всей монорепы,
- собирает `shared`, чтобы остальные пакеты видели актуальные типы.

## 3. Локальные ENV-файлы

- Backend шаблон: `backend-api/.env.example`
- Electron шаблон: `electron-app/.env.example`

Для локальной работы:

```powershell
Copy-Item backend-api/.env.example backend-api/.env
Copy-Item electron-app/.env.example electron-app/.env
```

Дальше нужно заполнить реальные локальные значения:

- PostgreSQL (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`)
- `MATRICA_JWT_SECRET`
- при необходимости интеграции: Telegram, Yandex Disk, release token

Секреты из VPS в репозиторий не переносим.

## 4. Ежедневные команды

```powershell
corepack pnpm run db:migrate
corepack pnpm run dev:backend
corepack pnpm run dev:electron
```

Дополнительно:

```powershell
corepack pnpm run build:shared
corepack pnpm run dev:web-admin
```

## 5. Release-скрипты на Windows

Root-скрипты `release:auto` и `release:ledger-publish` теперь не зависят от `bash`.

Они автоматически подхватывают `backend-api/.env`, если файл существует:

```powershell
corepack pnpm run release:auto
corepack pnpm run release:ledger-publish -- 1.2.3
```

## 6. Работа с VPS через MCP

Для серверных операций в Cursor используем MCP `vps-matricarmz`, а не ручной SSH в процессе агентной разработки.

Типичные сценарии:

- проверить статус backend
- посмотреть логи
- выполнить миграции
- перезапустить `systemd` сервисы
- проверить содержимое `/home/valstan/MatricaRMZ`

На момент подготовки этой среды:

- MCP-сервер доступен;
- на VPS есть `node v22.22.0` и `pnpm 10.26.1`;
- репозиторий находится в `/home/valstan/MatricaRMZ`.

## 7. Полезные замечания

- `backend-api` сам читает `backend-api/.env` через `dotenv/config`.
- Electron в dev-цикле ожидает переменные окружения из запускающей среды, поэтому для локальных переопределений держим отдельный `electron-app/.env` и запускаем через подготовленные команды/IDE-задачи.
- Если нужна работа строго против VPS backend, достаточно выставить `MATRICA_API_URL` на адрес сервера.

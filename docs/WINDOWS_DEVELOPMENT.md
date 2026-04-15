# Windows 11 Development

Короткий рабочий контур для локальной разработки на Windows 11 с доступом к VPS через Cursor MCP.

## 1. Базовый стек

- Рекомендуемый Node.js: `22.x LTS`, чтобы совпадать с VPS (`v22.22.0`).
- Пакетный менеджер: `pnpm@10.26.1` через `corepack`.
- IDE: Cursor / VS Code.
- Удаленный доступ к серверу: **OpenSSH** с Host-алиасом из `%USERPROFILE%\.ssh\config` (например `matricarmz`) — основной канал для агента в терминале; MCP `vps-matricarmz` — опционально, см. `docs/MCP_SETUP_WINDOWS.md` §8.

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

## 5. Lint и тесты

Перед релизом прогоняем проверки:

```powershell
corepack pnpm --filter @matricarmz/ledger build   # prerequisite для backend тестов
corepack pnpm run lint
corepack pnpm run test
```

`lint` проверяет все пакеты рекурсивно. `test` запускает `vitest run` в `shared` и `backend-api`.

Если backend-тесты падают с `Failed to resolve entry for package "@matricarmz/ledger"`, соберите ledger первой командой выше.

## 7. Release-скрипты на Windows

Root-скрипты `release:auto` и `release:ledger-publish` кроссплатформенны, не зависят от `bash`.

Они автоматически подхватывают `backend-api/.env`, если файл существует:

```powershell
corepack pnpm run release:auto
corepack pnpm run release:ledger-publish -- 1.2.3
```

На Windows `release:auto`:
- коммитит, бампит версию, тегирует, пушит в GitHub;
- deploy backend пропускается (нет systemd);
- GitHub Actions (`release-electron-windows.yml`) собирает Windows installer по тегу;
- без `gh` CLI ожидание артефакта и ledger publish пропускаются (делается позже с VPS).

Для полного пайплайна с Windows можно установить [GitHub CLI](https://cli.github.com/).

## 8. Работа с VPS (SSH и MCP)

**ИИ-агент в Cursor:** для операций на прод-VPS предпочтительно вызывать команды через **SSH** с использованием Host из локального `~/.ssh/config` (типичный алиас в этом проекте — `matricarmz`: нестандартный порт, пользователь `valstan`, ключ из профиля). Так проще повторять runbook-команды, смотреть полные логи и не упираться в таймауты MCP.

Пример:

```powershell
ssh matricarmz "systemctl is-active matricarmz-backend-primary.service matricarmz-backend-secondary.service"
```

**MCP `vps-matricarmz`:** остаётся удобным дополнением (настройка, типичные ошибки, `exec` / `sudo-exec`) — см. `docs/MCP_SETUP_WINDOWS.md`, в том числе §8 «SSH vs MCP».

Типичные сценарии на сервере:

- проверить статус backend;
- посмотреть логи (`journalctl`, nginx);
- выполнить миграции;
- перезапустить `systemd` сервисы;
- проверить содержимое `/home/valstan/MatricaRMZ`.

На момент подготовки этой среды:

- на VPS есть `node v22.22.0` и `pnpm 10.26.1`;
- репозиторий находится в `/home/valstan/MatricaRMZ`.

## 9. Полезные замечания

- `backend-api` сам читает `backend-api/.env` через `dotenv/config`.
- Electron в dev-цикле ожидает переменные окружения из запускающей среды, поэтому для локальных переопределений держим отдельный `electron-app/.env` и запускаем через подготовленные команды/IDE-задачи.
- Если нужна работа строго против VPS backend, достаточно выставить `MATRICA_API_URL` на адрес сервера.

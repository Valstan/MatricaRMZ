# Windows 11 Development

Короткий рабочий контур для локальной разработки на Windows 11 с **SSH-доступом к прод-VPS** (управление сервером — через OpenSSH в терминале, не через MCP).

## 1. Базовый стек

- Рекомендуемый Node.js: `22.x LTS`, чтобы совпадать с VPS (`v22.22.0`).
- Пакетный менеджер: `pnpm@10.26.1` через `corepack`.
- IDE: Cursor / VS Code.
- Удалённый доступ к прод-серверу: **только OpenSSH** с Host-алиасом из `%USERPROFILE%\.ssh\config` (например `matricarmz`). ИИ-агенту и разработчику нужно помнить: **прод настраивается и обслуживается командами через `ssh`**, полноценные shell-пайплайны и длинные логи — в обычном терминале.

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

### GitHub CLI (`gh`)

Чтобы `release:auto` на Windows **дождался** `.exe` в GitHub Release и мог **опубликовать ledger**, нужен **`gh` в PATH** и авторизация:

```powershell
gh version
gh auth login
```

Если `gh` установлен в `%LOCALAPPDATA%\Programs\GitHub CLI\bin`, добавьте каталог в пользовательский `PATH` (или переоткройте терминал после установщика MSI). Проверка: `gh auth status`.

Полный чеклист релиза (включая **обязательный** деплой на прод по SSH после изменений backend) описан в `docs/RELEASE.md`.

### Поведение `release:auto` на Windows

- коммитит при необходимости, бампит версию, тегирует, пушит в GitHub;
- **не** деплоит backend на прод (нет systemd) — после релиза синхронизация, сборка, миграции и перезапуски на VPS по `docs/RELEASE.md` и `docs/OPERATIONS.md`;
- GitHub Actions (`release-electron-windows.yml`) собирает Windows installer по тегу;
- **с `gh`:** ожидание `.exe`, скачивание в `%USERPROFILE%\.matricarmz\updates`, публикация в ledger (при `MATRICA_LEDGER_RELEASE_TOKEN` в `.env`);
- **без `gh`:** ожидание артефакта и ledger пропускаются — завершите на VPS (`pnpm release:ledger-publish` или `gh release download` в каталог обновлений).

## 8. Работа с прод-VPS (только SSH)

**ИИ-агент и разработчик:** любые операции на прод-VPS выполняйте через **SSH** с Host из локального `~/.ssh/config` (типичный алиас в этом проекте — `matricarmz`: нестандартный порт, пользователь `valstan`, ключ из профиля). Так доступны полные логи, произвольные команды и повторяемые runbook-шаги из `docs/OPERATIONS.md` и `docs/TROUBLESHOOTING.md`.

Пример:

```powershell
ssh matricarmz "systemctl is-active matricarmz-backend-primary.service matricarmz-backend-secondary.service"
```

Отдельный MCP/ssh-mcp для доступа к этому VPS **не является частью проекта** и не должен подставляться вместо SSH.

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

# Релиз MatricaRMZ (единая версия)

## Версия
Одна версия для всего проекта (клиент, backend, web-admin, shared).
Источник истины: файл `VERSION` в корне репозитория.

Старт новой схемы: **0.5.50**.

Формат: **MAJOR.MINOR.RELEASE**.

- `MAJOR` — несовместимые изменения.
- `MINOR` — заметные изменения без ломаний.
- `RELEASE` — монотонный счётчик релизов.

## Команда “выпусти релиз”

Важно:
- `pnpm release:auto` сам добавляет и коммитит все текущие изменения (без вопросов).
- Рабочее дерево можно не чистить вручную.
- Версия задаётся в `VERSION` (MAJOR.MINOR.RELEASE). При повышении MINOR — `RELEASE` начинаем с 0.

Команда релиза:
```bash
cd /home/valstan/MatricaRMZ
pnpm release:auto
```

Что делает `pnpm release:auto`:
- автоматически коммитит рабочее дерево (`git add -A`, `git commit -m "chore: session updates"`),
- если `VERSION` уже отличается от последнего тега — синхронизирует версии пакетов по `VERSION`,
- иначе автоматически повышает `RELEASE`,
- делает релизный коммит и тег `vX.Y.Z`,
- пушит `main` и теги,
- автоматически проверяет изменения в `backend-api` / `web-admin` / `shared` и, если есть — выполняет деплой и перезапуск сервиса.

## Быстрый релиз (оптимальный путь)
1) Обновить `VERSION` (если нужен переход MAJOR/MINOR).
2) Запустить `pnpm release:auto` один раз.
3) Дождаться артефактов Windows в GitHub Actions (см. ниже).

## Backend / Web‑admin после релиза (автоматически)
`pnpm release:auto` сам проверяет, были ли изменения в `backend-api`/`web-admin`/`shared`.  
Если да — автоматически выполняет деплой и перезапуск сервиса:
```bash
git pull --tags
pnpm install
pnpm -C shared build
pnpm -C backend-api build
pnpm --filter @matricarmz/web-admin build
sudo systemctl restart matricarmz-backend.service
```
Если backend/web-admin не менялись — шаг пропускается.

## Сборка и публикация клиента (Windows)

Артефакты Electron публикуются GitHub Actions по тегу `vX.Y.Z`.

Проверить, что workflow отработал:
- `release-electron-windows.yml` (в GitHub Actions)

Если нужно запустить вручную:
```bash
gh workflow run release-electron-windows.yml --ref vX.Y.Z
```

## Обновления клиента (Windows)

Обновления идут в порядке приоритета:
1) **Торрент** (сервер сидирует, клиенты — пиры/сиды в том числе внутри LAN).
2) **GitHub Releases** (дифференциально, blockmap).
3) **Yandex.Disk** (публичная папка `/latest`).

Клиент проверяет обновления при запуске и устанавливает их автоматически в silent‑режиме.

### Торрент‑обновления: размещение инсталлятора
- На сервере должен быть каталог, указанный в `MATRICA_UPDATES_DIR`.
- В этот каталог нужно положить **последний `.exe` инсталлятор** клиента (например `MatricaRMZ-0.6.0.exe`).
- Backend сам создаст `latest.torrent` и `latest.json`, запустит сидирование и отдачу по `/updates/*`.



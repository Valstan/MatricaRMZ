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
- автоматически пытается запустить сборку Windows через GitHub Actions (если доступен `gh` и есть авторизация).
- ждёт появления Windows‑артефакта, скачивает инсталлятор и проверяет `/updates/status`.

## Реестр релизов в ledger
После выпуска релиза **обязательно** зафиксировать его в on‑chain реестре.
Клиент сверяет версию/имя/размер/SHA256 установщика с данными ledger и откажется устанавливать
пакет при несовпадении.
```bash
curl -sS -X POST http://127.0.0.1:3001/ledger/releases/publish \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  --data '{"version":"X.Y.Z","notes":"short changelog","fileName":"MatricaRMZ-Setup-X.Y.Z.exe","sha256":"<hex>","size":12345678}'
```
SHA256 можно получить так:
```bash
sha256sum "MatricaRMZ-Setup-X.Y.Z.exe"
```

Параметры контроля Windows‑шага (env):
- `MATRICA_RELEASE_ASSET_WAIT_MS` — таймаут ожидания артефакта на одну попытку (по умолчанию 30000 мс).
- `MATRICA_RELEASE_ASSET_WAIT_ATTEMPTS` — количество попыток ожидания (по умолчанию 6).
- `MATRICA_RELEASE_DOWNLOAD_ATTEMPTS` — количество попыток скачивания артефакта (по умолчанию 3).
- `MATRICA_RELEASE_STATUS_WAIT_MS` — таймаут ожидания `/updates/status` (по умолчанию 120000 мс).

## Быстрый релиз (оптимальный путь)
1) Обновить `VERSION` (если нужен переход MAJOR/MINOR).
2) Запустить `pnpm release:auto` один раз.
3) Дождаться артефактов Windows в GitHub Actions (см. ниже).
4) Автоматически скачать `MatricaRMZ-Setup-X.Y.Z.exe` в `/opt/matricarmz/updates` (как только артефакт появился).
5) Автоматически проверить `/updates/status` → `lastError=null`, версия соответствует `X.Y.Z`.
6) Зафиксировать релиз в ledger (version/fileName/size/sha256) — см. команду ниже.

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

После завершения сборки Windows (автоматически):
- скачивается `MatricaRMZ-Setup-X.Y.Z.exe` в `/opt/matricarmz/updates`;
- проверяется `/updates/status` (ожидается `lastError=null` и версия `X.Y.Z`).

## Обновления клиента (Windows)

Обновления идут в порядке приоритета:
1) **Торрент** (сервер сидирует, клиенты — пиры/сиды в том числе внутри LAN).
2) **GitHub Releases** (дифференциально, blockmap).
3) **Yandex.Disk** (публичная папка `/latest`).
4) **LAN‑peer HTTP** (fallback, если основные источники недоступны).

Клиент проверяет обновления при запуске, скачивает в silent‑режиме и **устанавливает при следующем запуске**.
Во время загрузки через torrent клиенты сразу раздают скачанные блоки другим клиентам.
Перед установкой выполняется проверка по ledger (version/fileName/size/sha256).

### LAN‑peer раздача (fallback)
- Клиенты поднимают локальный HTTP (порт `MATRICA_UPDATE_LAN_PORT`, по умолчанию авто‑порт).
- Пиры регистрируются на сервере (`/updates/lan/peers`) и могут отдавать cached‑инсталлятор соседям.
- Используется только как резервный источник, когда торрент и центральные источники недоступны.

### Торрент‑обновления: размещение инсталлятора
- На сервере должен быть каталог, указанный в `MATRICA_UPDATES_DIR`.
- В этот каталог нужно положить **последний Setup‑инсталлятор** клиента (например `MatricaRMZ Setup 0.6.0.exe`).
- Backend сам создаст `latest.torrent` и `latest.json`, запустит сидирование и отдачу по `/updates/*`.



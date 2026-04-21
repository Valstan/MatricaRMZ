# Релиз и обновления MatricaRMZ

Этот документ фиксирует текущий рабочий процесс релиза и фактический update-flow клиента.

## Версионирование
- Единая версия для `electron-app`, `backend-api`, `shared`, `web-admin`.
- Источник истины: файл `VERSION` в корне.
- Формат: `MAJOR.MINOR.RELEASE`.

## Базовый релиз

Релиз состоит из двух независимых частей:
1. **Git / версия / тег / GitHub Release / ledger** — делает `pnpm release:auto` (локально на Windows или на VPS).
2. **Прод-VPS: актуальный код, сборка, миграции БД, перезапуск systemd** — делается **только по SSH**, даже если `release:auto` отработал полностью на Windows. Скрипт на Windows **не** перезапускает backend и **не** применяет миграции на сервере.

### Подготовка Windows (один раз)

1. Установите [GitHub CLI (`gh`)](https://cli.github.com/) и убедитесь, что `gh` доступен в `PATH` (после установки может понадобиться новое окно терминала).
2. Авторизация для доступа к релизам репозитория:
   ```powershell
   gh auth login
   ```
   Выберите `GitHub.com`, способ `HTTPS` или `SSH` как вам удобно, браузер или токен. Для неинтерактивных сценариев допустима переменная `GITHUB_TOKEN` (права на чтение релизов и репозитория).
3. В корне проекта должен быть `backend-api/.env` с **`MATRICA_LEDGER_RELEASE_TOKEN`** и URL API (**`MATRICA_API_URL`** или **`MATRICA_PUBLIC_BASE_URL`**) — их подхватывает `scripts/run-with-backend-env.mjs` при запуске `release:auto` / `release:ledger-publish`.

### С Windows (рекомендуемый путь разработчика)

```powershell
corepack pnpm run release:auto
```

При установленном **`gh`** и настроенном **`MATRICA_LEDGER_RELEASE_TOKEN`** скрипт после пуша тега:
- ждёт появления `.exe` в GitHub Release (workflow `release-electron-windows.yml`);
- скачивает установщик в **`%USERPROFILE%\.matricarmz\updates`** (на Windows; на Linux по-прежнему `/opt/matricarmz/updates`);
- при необходимости ждёт `updates/status` на API из `.env`;
- публикует релиз в ledger.

Если **`gh` не в PATH** или нет доступа к GitHub, шаг ожидания артефакта и публикации в ledger **пропускаются** — тогда дождитесь `.exe` и выполните на **VPS**: `pnpm release:ledger-publish X.Y.Z` (см. ниже).

### С VPS (как раньше, «всё на сервере»)

```bash
cd /home/valstan/MatricaRMZ
pnpm release:auto
```

На VPS скрипт по-прежнему может пересобрать и перезапустить backend, если менялись `backend-api` / `shared` / `web-admin`.

### Прод после тега: синхронизация, миграции, деплой (SSH)

Выполните по алиасу из `~/.ssh/config` (типично `matricarmz`), из каталога репозитория на сервере:

```bash
cd /home/valstan/MatricaRMZ
git fetch origin --prune
git pull --ff-only origin main
pnpm install
pnpm -C shared build
pnpm -C backend-api build
pnpm --filter @matricarmz/web-admin build
```

Если в релизе менялась схема БД под миграции backend:

```bash
pnpm --filter @matricarmz/backend-api db:migrate
```

Перезапуск **dual-backend** (порядок важен): сначала primary, дождаться `/health`, затем secondary:

```bash
sudo systemctl restart matricarmz-backend-primary.service
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/health   # ожидается 200
sudo systemctl restart matricarmz-backend-secondary.service
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/health   # ожидается 200
```

**Установщик в каталоге раздачи на сервере:** если ledger уже опубликован с Windows, повторный `release:ledger-publish` может быть не нужен. Если политика обновлений требует копию `.exe` на диске VPS (например под `/opt/matricarmz/updates`), скачайте артефакт с GitHub:

```bash
mkdir -p /opt/matricarmz/updates
gh release download vX.Y.Z --repo Valstan/MatricaRMZ --pattern "*.exe" -D /opt/matricarmz/updates --skip-existing
```

Подробности эксплуатации и nginx см. `docs/OPERATIONS.md`.

`release:auto` автоматически подхватывает env из `backend-api/.env` (если файл существует), включая `MATRICA_LEDGER_RELEASE_TOKEN`.

Если версия уже выставлена вручную (например `node scripts/bump-version.mjs --set 1.12.0`) и не нужно увеличивать `RELEASE` скриптом, перед `release:auto` задайте `MATRICA_RELEASE_SKIP_VERSION_BUMP=true` (иначе `pnpm version:bump` поднимет последнюю цифру).

## Что делает `release:auto`
- Коммитит рабочее дерево (если есть изменения).
- Выравнивает версии пакетов с `VERSION` (или повышает `RELEASE`, если тег уже существует).
- Создает релизный коммит и тег `vX.Y.Z`, пушит `main` и теги.
- **Только на Linux/VPS:** при изменениях `backend-api` / `web-admin` / `shared` пересобирает и перезапускает backend через systemd.
- **Если доступен `gh`:** ждёт Windows `.exe` в GitHub Release, скачивает установщик в каталог обновлений (см. выше), ждёт `updates/status` (если не отключено), публикует релиз в ledger при наличии `MATRICA_LEDGER_RELEASE_TOKEN`.
- **На Windows без `gh`:** этап ожидания артефакта и ledger пропускается — завершите вручную на VPS (`gh release download` + при необходимости `pnpm release:ledger-publish`).

Workflow **Release Electron (Windows)** (`release-electron-windows.yml`) вызывает `electron-builder --publish always`. По умолчанию electron-builder создаёт GitHub Release как **draft**; у нас в `electron-app/package.json` в `build.publish` для GitHub задано **`releaseType: release`**, чтобы релиз сразу был опубликованным и публичные ссылки на `.exe` работали (в т.ч. для `curl`/VPS без `gh release edit --draft=false`).

## Когда выпускать клиентский релиз при завершении сессии
Если сессия разработки закрывается по протоколу из `docs/README.md`, агент должен отдельно принять решение: достаточно ли только sync/deploy на сервер или уже нужен новый релиз Windows-клиента.

Клиентский релиз обязателен, если выполнено хотя бы одно условие:
- менялся `electron-app`;
- менялся `shared` и это влияет на IPC/DTO/контракты, которыми пользуется клиент;
- менялись backend-контракты, sync/auth/update-flow или поведение, от которого текущий Windows-клиент может работать некорректно;
- менялась логика автообновления, installer/update metadata, release pipeline или welcome/release UX;
- изменения должны попасть пользователям не только на сервере, но и в локальный runtime клиента;
- есть сомнение в обратной совместимости текущего клиентского релиза с новым продом.

Клиентский релиз обычно не нужен, если изменения ограничены:
- только документацией;
- только серверной эксплуатацией без смены клиентских контрактов;
- внутренним backend-рефакторингом без влияния на API/ledger/auth/update поведение для клиента.

Правило по умолчанию:
- если не удаётся уверенно доказать, что текущий клиент совместим с новым продом, выпускать новый клиентский релиз.

## Ручной fallback для ledger publish
Если `.exe` появился позже, чем скрипт дождался:

```bash
# VPS
pnpm release:ledger-publish

# Windows
corepack pnpm run release:ledger-publish -- 1.2.3
```

Или с явным путём:

```bash
pnpm release:ledger-publish 1.8.26 --installer "/opt/matricarmz/updates/MatricaRMZ Setup 1.8.26.exe"
```

## Обязательные условия для автообновлений
- Релиз должен быть опубликован в ledger (`/ledger/releases/publish`) с валидными:
  - `version`
  - `fileName`
  - `size`
  - `sha256`
- Без этого клиент не применит установку автоматически.

## Что проверить после server deploy / client release
- VPS checkout находится на том же commit, что и `origin/main`.
- `backend-api` / `web-admin` / нужные сервисы пересобраны и запущены без ошибок.
- Если контур dual-backend активен, перезапуск выполнен последовательно: `primary -> health -> secondary`.
- `systemctl` и `/health` подтверждают, что прод поднялся.
- Если выпускался клиентский релиз:
  - GitHub Release содержит `.exe` installer;
  - `updates/status` показывает актуальную версию без ошибок;
  - релиз опубликован в ledger с корректными `version/fileName/size/sha256`;
  - при необходимости обновлён `shared/src/domain/releaseWelcome.ts`.

## Актуальный update-flow клиента

Перед запуском клиента сначала проверяется версия на сервере:
- если серверная версия не выше текущей, приложение запускается сразу;
- если версия выше, используется каскад источников обновления.

Каскад поиска/скачивания новой версии:
1. Торрент-пиры в локальной сети
2. LAN peers (`/updates/lan/peers`)
3. Yandex.Disk
4. GitHub Releases
5. Любые торрент-пиры + webseed (`/updates/file/:name`)
6. Прямое скачивание с сервера (`/updates/file/:name`)
7. Ручной fallback: открыть прямую ссылку на Yandex.Disk в браузере по умолчанию и продолжить запуск приложения для работы

## Проверка целостности установщика перед запуском
- Перед запуском installer проходит валидацию:
  - наличие файла
  - корректный размер
  - SHA256 (если доступен)
- Если файл поврежден:
  1) попытка докачки (resume),
  2) если не помогло — удаление битого файла и полная перезакачка,
  3) повторная валидация.
- Если после перезакачки валидация не проходит — установка отменяется, pending update очищается.

## Поведение helper-процесса установки
- Update helper запускается отдельным процессом с `parentPid`.
- Helper ждет завершения основного процесса (с таймаутом), затем запускает `.exe`.
- NSIS-скрипт дополнительно закрывает основной клиентский `.exe` по имени, которое передает `electron-builder` (`APP_EXECUTABLE_FILENAME`), поэтому сценарий не зависит от ручного хардкода имени файла.

## Полезные переменные
- `MATRICA_RELEASE_ASSET_WAIT_MS`
- `MATRICA_RELEASE_ASSET_WAIT_ATTEMPTS`
- `MATRICA_RELEASE_ASSET_POLL_MS`
- `MATRICA_RELEASE_DOWNLOAD_ATTEMPTS`
- `MATRICA_RELEASE_STATUS_WAIT_MS`
- `MATRICA_RELEASE_STATUS_POLL_MS`
- `MATRICA_RELEASE_SKIP_STATUS_WAIT=true`
- `MATRICA_RELEASE_TRIGGER_WINDOWS_WORKFLOW=true`
- `MATRICA_LEDGER_RELEASE_TOKEN`
- `MATRICA_LEDGER_RELEASE_NOTES`

## Приветственное окно после обновления (обязательно для каждого релиза)
- Источник текста приветственного окна: `shared/src/domain/releaseWelcome.ts`.
- При каждом релизе обновляй `RELEASE_WELCOME_HISTORY`:
  - первая запись массива = новый текст текущего релиза;
  - вторая запись = предыдущий текст (для истории и сравнения).
- Перед клиентским релизом нейросеть-разработчик обязана:
  1) взять 3 последних приветственных текста из `RELEASE_WELCOME_HISTORY`,
  2) суммаризировать их в один связный человекопонятный текст,
  3) добавить к нему главное описание изменений текущей сессии / релиза,
  4) обновить первую запись массива новым релизным welcome-текстом.
- Критерии текста:
  - человекопонятный, позитивный, про реальные изменения текущего релиза;
  - без технического мусора и внутренних деталей;
  - должен отражать накопленный прогресс за 3 последних релиза и текущее обновление;
  - завершать пожеланием удобной и хорошей работы.



# Релиз и обновления MatricaRMZ

## Быстрый рецепт релиза (для ИИ-агента / автоматизации)

Это короткий контракт. Открывай детальные разделы ниже только если шаг не сработал.

**Что считается релизом:** новый тег `vX.Y.Z` в `origin/main`, сборка `.exe` через GitHub Actions, актуальный код + миграции БД + рестарт сервисов на VPS, запись в ledger.

### Шаги

1. **Версия.** Прочитать `VERSION`. Решить бамп: bugfix → patch (`1.14.19` → `1.14.20`); новая фича/контракт → minor. Применить: `node scripts/bump-version.mjs --set X.Y.Z`. Это синхронно обновит 4 `package.json` и `VERSION`.

2. **Приветственный текст.** В `shared/src/domain/releaseWelcome.ts` добавить **первой** записью массива `RELEASE_WELCOME_HISTORY` блок про новый `vX.Y.Z`: суммаризовать предыдущие 3 записи + ключевые изменения текущей сессии. Тон тёплый, без техжаргона, 3-6 highlights, outro с пожеланием.

3. **Коммит и push.** Один релизный коммит со всеми правками + bump:
   ```bash
   git add -A
   git commit -m "release: vX.Y.Z\n\n<1-3 строки про главное"
   git push origin main
   ```
   Если есть `MATRICA_LEDGER_RELEASE_TOKEN` в `backend-api/.env`, `corepack pnpm run release:auto` сделает то же + поставит тег + дождётся GitHub Action и опубликует в ledger. Но он может не работать на конкретной машине агента — тогда тег ставим вручную:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

4. **GitHub Action** `release-electron-windows.yml` соберёт `.exe` и приложит к Release. Это ~5-10 минут, ждать не обязательно — деплой на VPS не зависит от `.exe`.

5. **Деплой на VPS** (по `ssh matricarmz`, в `/home/valstan/MatricaRMZ`):
   ```bash
   git fetch origin --prune
   git pull --ff-only origin main
   pnpm install
   pnpm -C shared build && pnpm -C backend-api build && pnpm --filter @matricarmz/web-admin build
   # миграции — только если в этом релизе менялась схема БД (PostgreSQL):
   pnpm --filter @matricarmz/backend-api db:migrate
   sudo systemctl restart matricarmz-backend-primary
   curl -fsS http://127.0.0.1:3001/health   # ожидается ok
   sudo systemctl restart matricarmz-backend-secondary
   curl -fsS http://127.0.0.1:3002/health   # ожидается ok
   ```

6. **Публикация в ledger** (если `release:auto` не дошёл до этого шага — например, `.exe` появился после таймаута):
   ```bash
   # на VPS, когда .exe уже скачан в /opt/matricarmz/updates/
   pnpm release:ledger-publish vX.Y.Z
   # либо явно:
   pnpm release:ledger-publish 1.14.20 --installer "/opt/matricarmz/updates/MatricaRMZ Setup 1.14.20.exe"
   ```
   Если `.exe` ещё не на сервере:
   ```bash
   mkdir -p /opt/matricarmz/updates
   gh release download vX.Y.Z --repo Valstan/MatricaRMZ --pattern "*.exe" -D /opt/matricarmz/updates --skip-existing
   ```

7. **Проверка**: VPS на нужном коммите, оба `/health` зелёные, `updates/status` отдаёт нужную версию, в ledger опубликован релиз с валидными `version`/`fileName`/`size`/`sha256`.

### Когда клиентский релиз НЕ нужен

Только если изменения касаются исключительно: документации, бэкенд-рефакторинга без смены контрактов, server-only фич без UI/IPC изменений. Во всех других случаях — релиз обязателен. При сомнении — релизим.

---

## Принципы

- Единая версия для `electron-app`, `backend-api`, `shared`, `web-admin`. Источник истины — `VERSION` в корне. Формат `MAJOR.MINOR.RELEASE`.
- Релиз состоит из двух независимых частей: **git/тег/GitHub Release/ledger** (можно с Windows через `release:auto`) и **деплой на VPS** (только по SSH; `release:auto` на Windows не трогает прод).
- Если на машине нет `gh` или нет токена ledger — части автоматизации пропускаются молча, и завершать релиз надо вручную с VPS (`gh release download` + `pnpm release:ledger-publish`).
- Welcome-текст релиза обязателен — это единственное, что пользователь видит после обновления.

---

## Что делает `release:auto` подробно

- Коммитит рабочее дерево (если есть несохранённые правки).
- Выравнивает версии 4 `package.json` с `VERSION`, либо повышает `RELEASE`, если тег `vX.Y.Z` уже существует.
- Создаёт релизный коммит и тег, пушит `main` и теги.
- **На Linux/VPS:** при изменениях `backend-api` / `web-admin` / `shared` пересобирает и рестартит backend через systemd.
- **Если доступен `gh`:** ждёт `.exe` в GitHub Release, скачивает в `%USERPROFILE%\.matricarmz\updates` (Windows) или `/opt/matricarmz/updates` (Linux), ждёт `updates/status` на API, публикует в ledger при наличии `MATRICA_LEDGER_RELEASE_TOKEN`.
- Если версия уже выставлена вручную и поднимать `RELEASE` не нужно — выставить `MATRICA_RELEASE_SKIP_VERSION_BUMP=true`.

Workflow `release-electron-windows.yml` вызывает `electron-builder --publish always`. В `electron-app/package.json` `build.publish.releaseType: release` — релиз сразу публикуется, не draft.

---

## Подготовка Windows (один раз для разработчика)

1. Установить [GitHub CLI](https://cli.github.com/), `gh` должен быть в `PATH`.
2. `gh auth login` — GitHub.com / HTTPS или SSH / браузер или токен. Для неинтерактивного режима подходит `GITHUB_TOKEN`.
3. В `backend-api/.env` должны быть `MATRICA_LEDGER_RELEASE_TOKEN` и URL API (`MATRICA_API_URL` или `MATRICA_PUBLIC_BASE_URL`) — их подхватывает `scripts/run-with-backend-env.mjs`.

---

## Обязательные условия автообновлений

Релиз должен быть опубликован в ledger (`POST /ledger/releases/publish`) с валидными:
- `version`
- `fileName`
- `size`
- `sha256`

Без этого клиент не подтянет апдейт.

## Update-flow клиента (каскад)

При старте клиент сверяет свою версию с серверной. Если серверная выше — ищет installer в таком порядке:
1. Торрент-пиры в локальной сети
2. LAN peers (`/updates/lan/peers`)
3. Yandex.Disk
4. GitHub Releases
5. Любые торрент-пиры + webseed (`/updates/file/:name`)
6. Прямое скачивание с сервера (`/updates/file/:name`)
7. Ручной fallback: открыть прямую ссылку Yandex.Disk в браузере, продолжить запуск приложения

Установщик перед запуском валидируется (наличие / размер / SHA256). Если файл битый: попытка докачки, потом перезакачка, потом отмена и очистка pending. Helper-процесс запускается отдельно, ждёт завершения основного клиента и запускает `.exe`. NSIS-скрипт закрывает основной `.exe` по `APP_EXECUTABLE_FILENAME` от `electron-builder`.

---

## Полезные переменные окружения

- `MATRICA_RELEASE_ASSET_WAIT_MS`, `..._ATTEMPTS`, `..._POLL_MS` — таймауты ожидания артефактов в GitHub Release.
- `MATRICA_RELEASE_DOWNLOAD_ATTEMPTS` — число попыток скачивания.
- `MATRICA_RELEASE_STATUS_WAIT_MS`, `..._POLL_MS`, `MATRICA_RELEASE_SKIP_STATUS_WAIT=true` — про `updates/status`.
- `MATRICA_RELEASE_TRIGGER_WINDOWS_WORKFLOW=true` — принудительный триггер workflow.
- `MATRICA_LEDGER_RELEASE_TOKEN` — токен публикации в ledger.
- `MATRICA_LEDGER_RELEASE_NOTES` — текст для ledger entry.
- `MATRICA_RELEASE_SKIP_VERSION_BUMP=true` — не поднимать `RELEASE` (когда версия уже выставлена вручную).

---

## Чек-лист после деплоя

- VPS checkout на том же commit, что и `origin/main`.
- `backend-api` / `web-admin` пересобраны без ошибок, `db:migrate` (если был) прошёл.
- `primary -> /health -> secondary` поднялись в правильном порядке.
- GitHub Release содержит `.exe` installer.
- `updates/status` показывает актуальную версию.
- Релиз в ledger с валидными `version` / `fileName` / `size` / `sha256`.
- `shared/src/domain/releaseWelcome.ts` обновлён первой записью (новейший релиз сверху).

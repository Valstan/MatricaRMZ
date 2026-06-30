# Машина: rmz4val

> Профиль окружения этого компа. Читается `/start` §0.5 по hostname. Пиши сюда по мере изучения. Без секретов. Конвенция — [`README.md`](README.md).

**Hostname:** rmz4val
**OS:** Windows 11 Pro (10.0.22631)
**Папка репозитория:** `D:\PROGRAMMING\MatricaRMZ` (brain рядом: `D:\PROGRAMMING\brain_matrica`)
**Shell:** PowerShell (основной) + Git Bash (Bash tool)

## Порты / сервисы (dev-стенд)
- **PostgreSQL (локальный dev):** служба **`postgresql-x64-17`** (StartType **Manual** → может быть Stopped на старте; поднять `Start-Service postgresql-x64-17`). Порт **5432** (дефолт, НЕ 5433 как на PC40). БД verifier: **`matricarmz_probe`**, host `127.0.0.1`, user `postgres`. Пароль — в `backend-api/.env.dev` (`PGPASSWORD`). Есть ещё служба `PostgreSQL` (Disabled) — игнор.
- **Backend dev (verifier-electron):** `http://127.0.0.1:3001` (`PORT=3001` в `.env.dev`).
- **Electron renderer env (`.env.dev`):** `MATRICA_API_URL=http://127.0.0.1:3001`, `MATRICA_SYNC_V2=1`, `MATRICA_UPDATE_PEER_HTTP_PORT=3001`, `MATRICA_UPDATE_LAN_ENABLED=0`.

## Инструменты / пути
- **Node/pnpm:** `corepack pnpm` (стандартно).
- **psql.exe** — путь не зафиксирован (искать в `C:\Program Files\PostgreSQL\17\bin\`). Для прод-SQL — через `ssh matricarmz`.
- **Go — НЕ установлен.** Watchdog (`watchdog/main.go`) собирается только в CI (`watchdog-build.yml` + релизный workflow). Локально build/vet нельзя без установки Go-тулчейна.
- **Нет outbound HTTPS на прод** (прямой `curl https://a6fd55b8e0ae.vps.myjino.ru/health` = timeout). На прод этот комп ходит **только через `ssh matricarmz`** (порт 49217). Поэтому watchdog-репорт на прод с этого стенда не проверить — только механизм восстановления локально.

## Watchdog: петля on-machine теста (Фаза 5, 2026-06-22)
Этот комп = тест-стенд для watchdog'а (реальная Windows 11). Петля без локального Go:
1. Запушить ветку → `gh workflow run "Release Electron (Windows)" --ref <branch>` (`workflow_dispatch` → сборка без публикации, артефакт `matricarmz-installer-test`).
2. `gh run download <id> -n matricarmz-installer-test -D <dir>` (из репо — gh нужен git-контекст).
3. Тихий install: `Start-Process '<Setup>.exe' -ArgumentList '/S' -Wait`. **Важно:** реальная install-папка — `%LOCALAPPDATA%\Programs\@matricarmzelectron-app\` (НЕ `MatricaRMZ`).
4. Проверка задач: `schtasks /Query /TN 'MatricaRMZ\Watchdog Periodic' /XML`.
5. Handshake для теста писать **без BOM** (`[System.IO.File]::WriteAllText` + `UTF8Encoding $false`) — Go json.Unmarshal давится BOM от `Set-Content -Encoding UTF8`.
6. Снести install-папку → запустить watchdog.exe напрямую → лог `%APPDATA%\MatricaRMZ\watchdog.log`.
7. Убрать: тихий `Uninstall MatricaRMZ.exe /S` (снимает задачи) + чистка `%APPDATA%\MatricaRMZ` и temp.

## better-sqlite3 ABI (GOTCHAS M2) — ключевая грабля этого стека
- Один инстанс better-sqlite3 на репо, ABI слетает при смене стека:
  - **Перед backend-тестами / vitest electron-app под Node:** `corepack pnpm rebuild better-sqlite3` (Node-ABI = `NODE_MODULE_VERSION 137`).
  - **Перед запуском Electron-клиента (verify):** `corepack pnpm -C electron-app exec electron-builder install-app-deps` (Electron-ABI = `145`).
- **Симптом несовпадения:** `Error: ... better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 145. This version requires 137` (или наоборот). На 2026-06-20 бинарь был под **Electron (145)** → vitest `electron-app` падал на `warehouseCommandOutboxService.test.ts` (`new Database`) — это ABI-состояние, не регрессия кода. Backend (PostgreSQL, не использует better-sqlite3) от ABI не зависит.
- **⚠️ `install-app-deps` МОЛЧА НЕ ПЕРЕСОБИРАЕТ (выучено 2026-06-27).** `electron-builder install-app-deps` зовёт `@electron/rebuild` **без `--force`** → тот решает «уже актуально» и выходит за <1с с `finished better-sqlite3` / `completed`, **не трогая бинарь** (даже если бинарь под Node-ABI 137, и даже если бинарь УДАЛЁН — всё равно «finished», файла нет). Симптом в Electron-клиенте: окно показывает **ошибку БД**, `matricarmz.log` → `sqlite init failed … NODE_MODULE_VERSION 137 … requires 145`, `DB self-heal LOOP → emergency update mode`; CDP `/json/list` пуст. **Рабочее лечение — звать `@electron/rebuild` напрямую с `--force`:**
  ```bash
  cd electron-app && node ../node_modules/.pnpm/@electron+rebuild@4.0.4/node_modules/@electron/rebuild/lib/cli.js --force --version 41.7.1 --arch x64 --only better-sqlite3
  ```
  (реально компилирует ~30с, бинарь обновляется). Версию Electron брать из `electron-app/node_modules/electron/package.json` (на 2026-06-27 = 41.7.1 → ABI 145). После — перезапустить только `electron.exe` (backend на Node-ABI не зависит).
- **Клиентский лог verify-стека:** `C:\Users\Valstan\AppData\Roaming\@matricarmz\electron-app-cdp-9222\matricarmz.log` (изолированный userData при `MATRICA_CDP_PORT`). Грепать тут sqlite/ABI/cold-sync ошибки клиента — в `electron.log` стенда их НЕТ (там только stdout `pnpm dev`).

## Скиллы (как поднимать на этом компе)
### verifier-electron (`/verify` Electron)
- `.env.dev` для `backend-api` и `electron-app` уже есть (PG 5432, `matricarmz_probe`).
- Backend dev — Node, PostgreSQL → better-sqlite3 НЕ требуется (не ребилдить ради backend).
- Electron-клиент → better-sqlite3 должен быть под Electron-ABI (см. выше).

## Машинные грабли
- **PG-служба `postgresql-x64-17` Manual** — самопроизвольно/после ребута Stopped; поднимать `Start-Service postgresql-x64-17` перед verify (на 2026-06-20 была уже Running).
- **`@electron/rebuild` теперь `3.6.1` (не `4.0.4`), выучено 2026-06-28.** Профильная `--force`-команда выше указывает путь `@electron+rebuild@4.0.4/...` — его НЕТ; реально установлен `3.6.1`, а его `node-abi@3.85.0` **не знает Electron 41.7.1** → `Error: Could not detect abi for version 41.7.1 and runtime electron`. То есть оба rebuild-пути (install-app-deps no-op + прямой cli) сейчас не работают. **Но** на 2026-06-28 verify-стек поднялся и драйвился БЕЗ пересборки — бинарь better-sqlite3 остался под Electron-ABI 145 с прошлой сессии (backend/shared/electron-vitest его не трогали). Вывод: сначала **просто запускать стек**; пересборку трогать только если клиент реально пишет ABI-ошибку в `matricarmz.log`.
- **CDP `Page.reload` на запущенном Vite-dev стеке убивает Electron (выучено 2026-06-28).** `Page.reload`/навигация рендерера через CDP на работающем `pnpm dev` → `electron.exe` завершился, `pnpm dev` вышел (фоновая задача «completed»), CDP пропал. Не делать reload для «сброса грязной карточки» — лучше **перезапустить только `electron.exe`** (backend оставить). На свежем старте стека reload и так не нужен (логин-экран чист).
- **Dev-backend `dev:no-watch` (tsx src/index.ts, БЕЗ watch) — после правки backend-исходников нужен РЕСТАРТ (выучено 2026-06-28).** `start-backend.ps1` поднимает backend одним бутом без `--watch` (чтобы не было restart-storm). Поэтому новый route/сервис в `backend-api/src` **не подхватится** работающим инстансом — `stop.ps1` + `start-backend.ps1` заново. Симптом: новый route → `ERR_CONNECTION_REFUSED`/404 из electron, при этом старые эндпоинты живут. Проверка загрузки route: `curl -X POST http://127.0.0.1:3001/<route>` → `401` (загружен, нужна авторизация) vs `404` (не загружен). NB: при упавшем backend клиентский `stockList`-хелпер может молча возвращать 0 (маскирует down под «пустой остаток») — проверяй сам `/health`.
- **`resolvePartIdToNomenclatureMap` (backend) принимает И nomenclature-id (→ маппит в себя), И directory_ref-id (→ зеркальную номенклатуру).** Удобно для тестов: можно передать id номенклатуры как partId.
- **Меню: «Наряды» — в группе «📦 Снабжение»** (таб `🛠️ Наряды`), не «Производство» (там карточка двигателя). `CODEBASE_MAP` маппит страницу `WorkOrdersPage` на «Производство» по смыслу, но в UI-меню наряды живут в Снабжении. Кнопка создания — «Создать наряд». Карточку из списка закрывать кнопкой **«Закрыть карточку»** (НЕ «Закрыть наряд» — та проводит/закрывает наряд!). Заявки — таб `📦 Заявки` в той же группе, кнопка «Создать закупку».
- **CDP-драйв полей даты: это НЕ `<input type="date">`, а `react-datepicker` (текстовый `input.matrica-datepicker-input`, формат `dd.MM.yyyy`) через компонент `UnifiedDateInput` (выучено 2026-06-29).** `document.querySelector('input[type=date]')` вернёт пусто на карточках наряда/заявки/двигателя. Драйвить дату синтетически неудобно (onChange только через календарь). Для маркера правки в CDP-смоуке бери что-то простое и читаемое: **добавить сотрудника + КТУ** (наряд) или **«Добавить товар»** (заявка) — кнопка + `input[type=number]`.
- **CDP-навигация по табам: открывать группу dept только если таб не виден** (как `gotoStockBalances` в `cdp-drive.mjs`; выучено 2026-06-29). Слепой `btn('Снабжение').click()` при уже открытой группе **сворачивает** её → таб пропадает → «no tab». Матчить таб «Заявки» как `includes('Заявки') && !includes('наряды') && !includes('Снабжение')` (иначе ловит dept-кнопку с подзаголовком «Заявки, наряды и снабжение»).
- **Стек для CDP держать долгоживущей фоновой задачей** (`pnpm --filter @matricarmz/electron-app dev` с env из `.env.dev` + `MATRICA_CDP_PORT=9222`), НЕ через `start-electron.ps1` — он возвращается, и харнесс убивает дерево процессов (Vite :5173 падает, electron на `chrome-error://`). Backend — отдельной задачей (`start-backend.ps1`), он живёт пока жив дочерний node. Kill `electron.exe` завершает dev-задачу (electron-vite выходит) → для «рестарта» перезапускать всю dev-задачу (userData `electron-app-cdp-9222` персистится → черновики/данные уцелевают).
- **Dual-role CDP verify (несколько логинов в одном клиенте, выучено 2026-07-01).** dev-БД = прод-снапшот → реальные сотрудники/данные уже там, сеять не надо. Чтобы залогиниться под снапшот-аккаунтом: задать ему известный пароль **прямым SQL** на `matricarmz_probe` (bcryptjs(12) → `attribute_values` для `password_hash` + `access_enabled='true'`), минуя `setEmployeeAuth` (на снапшоте он кидает `sync_conflict`). **Грабля:** при переключении ролей в одном клиенте инкрементальный sync НЕ дотягивает данные нового юзера (seq-drift) → нужен `window.matrica.sync.fullPull()`. Но `fullPull` сталкивается с post-login авто-sync'ом (`runOnce` сериализован → `{ok:false}`) → **ретраить fullPull до `ok:true`** (авто-sync отпускает за ~10–25с). `roleCheck`/драйвер — образец в `.verifier-electron/_iso-cdp.mjs` (gitignored). Ассерт по `window.matrica.workOrders.list()` (`{ok,rows[]}`) — тот же путь, что рендерит `WorkOrdersPage`. Роли в снапшоте: `verify`/`valstan`=admin, многие реальные операторы=`user` (см. `system_role` EAV); admin видит всё, поэтому для негативного теста изоляции нужен именно `role=user` не из allowlist.

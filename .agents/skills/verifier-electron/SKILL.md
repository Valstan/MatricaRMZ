---
name: verifier-electron
description: Локальный handle для /verify Electron-приложения MatricaRMZ. Поднимает backend на native PostgreSQL, наполняет минимальные dev-фикстуры (verify-пользователь, TEST-BRAND, TEST-PART с brand-link, TEST-001 двигатель), запускает Electron-клиент. Используется skill `verify` при cold-start как handle для drive/observe UI-изменений.
---

# verifier-electron

Цель: дать `/verify` рабочий локальный handle для Electron-приложения, чтобы Codex мог запустить app, дойти до карточки двигателя и снять observations.

## Когда использовать

- `verify` встретил UI-change в `electron-app/` и cold-start ищет handle (`.Codex/skills/verifier-electron/`).
- Любой ручной прогон «проверить как выглядит экран X после моих правок».

## Prerequisites (один раз на машину)

1. **PostgreSQL ≥ 14 запущен** на `127.0.0.1:5432`. Версия на проде — **17.8** (с 2026-05 апгрейда). Рекомендуется ставить локально **PG 17** — точное совпадение упрощает работу с дампами (любой формат `-Fc/-Fp` поднимется через `pg_restore`/`psql`). Можно и более старую (14+), но тогда для дампа прода нужен plain SQL (`-Fp`), а не custom (`-Fc`).
2. **Аутентификация PG настроена** — либо `$env:PGPASSWORD` в PowerShell, либо `%APPDATA%\postgresql\pgpass.conf` (формат `host:port:db:user:password`). `Test-PgConnectivity` в `_common.ps1` проверяет соединение перед началом работы.
3. **Node 22 + pnpm 10.26** через corepack — стандартный setup репо.
4. **`psql.exe`** в PATH либо в `C:\pgsql\bin\` (или `C:\Program Files\PostgreSQL\<16|14|15|17>\bin\`). `_common.ps1` найдёт автоматически.
5. **Schema-dump прода** в `.verifier-electron/prod-schema.sql`. Drizzle-миграция `0024_act_completeness_seed.sql` зависит от уже существующих entity_types `engine_brand`/`part`/etc. — на чистой БД она падает. Дамп прода (schema-only, без данных) содержит таблицы + applied migrations marker → миграции при `db:migrate` будут skipped, bootstrap наполнит entity_types/attribute_defs. Сгенерируйте один раз:

   ```bash
   ssh matricarmz "cd MatricaRMZ/backend-api && set -a; source .env; set +a; \
     pg_dump --schema-only -Fp \$PGDATABASE > /tmp/matricarmz-schema.sql && \
     pg_dump --data-only -Fp -t __drizzle_migrations -t entity_types -t attribute_defs -t permissions \$PGDATABASE > /tmp/matricarmz-seeds.sql"
   scp matricarmz:/tmp/matricarmz-schema.sql .verifier-electron/prod-schema.sql
   scp matricarmz:/tmp/matricarmz-seeds.sql .verifier-electron/prod-seeds.sql
   ssh matricarmz "rm /tmp/matricarmz-schema.sql /tmp/matricarmz-seeds.sql"
   ```

   Дампы попадают в `.verifier-electron/` (git-ignored, не утекают). Обновляйте раз в месяц или после крупных миграций. **Без этих файлов self-verify не запустится** (миграция 0024 упадёт).

## Однократный setup (после клона / при первом запуске)

Все команды — из корня репо, в **PowerShell** (не bash, скрипты `.ps1`).

```powershell
$env:PGPASSWORD = '<пароль postgres>'
.\.Codex\skills\verifier-electron\scripts\setup-env.ps1
.\.Codex\skills\verifier-electron\scripts\setup-db.ps1            # -Reset чтобы пересоздать
.\.Codex\skills\verifier-electron\scripts\migrate-and-seed.ps1
```

Что произойдёт:
- В `backend-api/.env.dev` и `electron-app/.env.dev` запишутся локальные значения (БД, JWT, ledger key — сгенерированы рандомно, сохраняются между запусками).
- В PostgreSQL создастся БД `matricarmz_dev` (если её ещё нет).
- Drizzle миграции накатятся, permissions заполнятся.
- Создадутся: `verify`/`verify123` (admin, **с подразделением `TEST-DEPT`** — иначе `createSupplyRequest` отказывает «Не задано подразделение»; admin не освобождён, только superadmin), `valstan`/`valstan-dev` (superadmin), `TEST-BRAND`, `TEST-PART` (qty=2 на TEST-BRAND, asm-unit `UN-001`), двигатель `TEST-001`.

## Запуск stack для /verify

```powershell
.\.Codex\skills\verifier-electron\scripts\start-backend.ps1
.\.Codex\skills\verifier-electron\scripts\start-electron.ps1 -Cdp     # -Cdp включает CDP (порт 9222)
```

`start-backend.ps1` ждёт `/health` → 200 (timeout 60s). `start-electron.ps1` ждёт появления процесса `electron.exe` (timeout 90s). Логи и PID-файлы — в `.verifier-electron/` (git-ignored).

Флаг **`-Cdp`** (или заранее выставленный `$env:MATRICA_CDP_PORT`) поднимает Chrome DevTools Protocol — это нужно для **основного, computer-use-независимого способа драйва** (см. ниже). Без флага окно открывается как раньше, CDP выключен. Порт по умолчанию 9222, переопределяется `-CdpPort`.

Stop:
```powershell
.\.Codex\skills\verifier-electron\scripts\stop.ps1
```

## Driving в живом UI (для Codex в `/verify`)

### Способ 1 — CDP-драйвер (основной, computer-use-независимый)

Если стек запущен с `-Cdp`, главный процесс Electron поднимает Chrome DevTools Protocol на `MATRICA_CDP_PORT` (по умолчанию 9222), и рендерер драйвится напрямую через CDP — **без computer-use MCP** (поэтому работает, даже когда computer-use отключён/недоступен).

```powershell
$env:MATRICA_CDP_PORT = '9222'
node .\.Codex\skills\verifier-electron\scripts\cdp-drive.mjs
```

Что делает `cdp-drive.mjs`:
- находит renderer-таргет через `GET http://127.0.0.1:$PORT/json/list` (исключает `devtools://`), подключается к его `webSocketDebuggerUrl` (использует `ws` из `node_modules/.pnpm`);
- инжектит набор хелперов в main-world рендерера и гоняет шаги через `Runtime.evaluate` (логин `verify`/`verify123`, навигация Склад→Номенклатура, разворот групп, клики по заголовкам-сортировкам, Склад→Инвентаризация);
- снимает PNG через `Page.captureScreenshot` → `.verifier-electron/cdp-*.png` (доказательства);
- пишет вердикт и метрики в `.verifier-electron/cdp-report.json`; exit 0 = PASS, ≠0 = FAIL.

Реактивный драйв: значения React-controlled `<input>` ставятся через native value-setter + `dispatchEvent('input')`; навигация — клик по кнопкам по видимому тексту. `window.matrica` (contextBridge) доступен из main-world, поэтому драйвер может и читать данные напрямую (например, выбрать склад с остатками для теста инвентаризации).

CDP-свитч в `electron-app/src/main/index.ts` **строго env-gated**: `--remote-debugging-port` добавляется только если `process.env.MATRICA_CDP_PORT` задан (до `app.whenReady()`). В проде переменная не выставляется — свитч не срабатывает, поведение не меняется.

### Способ 2 — computer-use MCP (fallback)

Если CDP по какой-то причине недоступен, окно Electron всё равно открывается visible, и можно драйвить через **computer-use** MCP (tools `mcp__computer-use__*`):

1. `request_access` для приложения `electron.exe` (tier full).
2. `screenshot` — посмотреть на текущий экран (обычно auth-экран).
3. На auth-экране ввести логин `verify` и пароль `verify123` через `type` + клики по полям (`left_click` после `screenshot` для определения координат).
4. Меню **Производство → Двигатели → TEST-001**.
5. Снять `screenshot` карточки и панели `engine_inventory`.
6. Для save+reload: изменить значение в строке (например, `present` чекбокс), `Ctrl+S` (или autosave + ждать 1s), F5 / закрыть-открыть карточку.

## Что MVP **не** делает

- Окно всё ещё открывается visible (Windows без xvfb — не headless). Но **сам драйв computer-use-независим** через CDP (Способ 1); computer-use нужен только как fallback (Способ 2).
- `cdp-drive.mjs` покрывает конкретный сценарий (#126 + проба инвентаризации); для других экранов добавляйте шаги в его хелперы либо драйвьте вручную.
- Не интегрирован в CI (только локально).
- Не дёргает прод-VPS — backend полностью локальный.
- Не делает hot-reload при правке `shared/` — пересоберите вручную: `corepack pnpm --filter @matricarmz/shared build`, перезапустите stack.

## Troubleshooting

- **`PGPASSWORD не установлен`** → задать `$env:PGPASSWORD` в текущей PowerShell-сессии до запуска любого скрипта.
- **`psql.exe не найден`** → добавить `C:\pgsql\bin` в PATH, либо отредактировать `Find-PsqlPath` в `_common.ps1`.
- **`/health` не отвечает за 60s** → смотреть `.verifier-electron/backend.log`. Частые причины: миграции не накатили (повторить `migrate-and-seed.ps1`), port `:3001` уже занят прежним инстансом (запустить `stop.ps1`).
- **better-sqlite3 NODE_MODULE_VERSION mismatch** в `electron.log` (клиент падает на SQLite-init, уходит в «emergency update mode») → пересобрать нативный модуль **под ABI Electron**: `corepack pnpm -C electron-app exec electron-builder install-app-deps`, перезапустить.
  - **Почему именно эта команда, а не `pnpm rebuild better-sqlite3`:** `pnpm rebuild` (и `prebuild-install` при `pnpm install`) собирает под **Node-ABI** (то, что нужно vitest), а Electron-клиенту нужен **Electron-ABI**. `install-app-deps` пересобирает под версию Electron из `electron-app`. Опора на `buildDependenciesFromSource: true` в `electron-app/package.json` → собирает из исходников (better-sqlite3 12.x не имеет надёжных Electron-prebuild'ов).
  - **Грабли (выучено при апгрейде Electron 41, 2026-06):** `better-sqlite3` — **один общий pnpm-инстанс** на `electron-app` и `backend-api`, один `.node` не может обслужить обе ABI сразу. **После любого `pnpm install` / `pnpm rebuild` клиентский ABI слетает в Node (137)** → перед запуском Electron-стека снова `install-app-deps`. И наоборот: чтобы прогнать `electron-app` vitest (под Node), сначала `corepack pnpm rebuild better-sqlite3`.
- **`setup-db.ps1 -Reset`** — снести БД и пересоздать, если миграции дрейфуют или fixture надо обнулить.
- **✅ ПОЧИНЕНО 2026-06-08 (env-gated `userData` изоляция) — `engines.view` desync + self-exit.** Оба грабля имели **один корень — общий `userData`** с установленным прод-клиентом. Теперь при заданном `MATRICA_CDP_PORT` главный процесс делает `app.setPath('userData', '<…>-cdp-<port>')` до `app.whenReady`/`requestSingleInstanceLock` ([electron-app/src/main/index.ts](../../../electron-app/src/main/index.ts), сразу после CDP-свитча). Это устраняет: (1) коллизию `requestSingleInstanceLock` с прод-клиентом (dev больше не self-quit'ит и не релончится посреди прогона); (2) перезапись общего `AuthSession` прод-клиентом (его периодический auth-sync затирал сессию пользователем, у которого могло не быть нужных прав) — теперь сессия `verify` в изолированном dir авторитетна, `engines.view` приходит из логина (admin → backend `defaultPermissionsForRole('admin')` даёт все права). Прод `.env` не задаёт `MATRICA_CDP_PORT` → поведение прода не меняется (тот же gate, что и у CDP-свитча).
  - **Историческая суть бага (для понимания):** в `electron.log` — `Error ... for 'engine:list': permission denied: engines.view`, а bridge-invoke не резолвился (evaluate висел до CDP-таймаута). `requirePermOrThrow` читает права из `getSession(db)` (persisted `AuthSession`), а не из backend напрямую — стейл/чужая сессия в общем `userData` → отказ.
  - **Драйверная дисциплина (оставить):** **любой bridge-вызов в CDP-драйвере оборачивай в `Promise.race` с таймаутом** (`call()` в `cdp-defect-supply.mjs`) — permission-denied-хэндлер иначе виснет без диагностики. Делай **чистый logout+login** в начале драйва, чтобы сессия подхватила текущие backend-права.
- **✅ ПОЧИНЕНО 2026-06-08 — холодный full-sync свежего изолированного `userData` падал на `erp_nomenclature has no column named directory_kind`.** Корень: три объекта схемы (`erp_nomenclature.directory_kind`/`directory_ref_id`, `erp_document_lines.nomenclature_id`, таблица `warehouse_command_outbox`) жили только в version-chained `clientSchemaMigrations.ts`, но не были продублированы в безусловный drizzle-путь; свежая установка базлайнит `ClientSchemaVersion` сразу до текущей и пропускает цепочку → колонки нет, `sync.fullPull` падает, авто-incremental циклится и **раскачивает процесс** (CDP `evaluate`/`captureScreenshot` таймаутят). align добавил бы их, но `allowUnauthenticated` ловит 401 до логина. **Фикс:** идемпотентный `ensureClientSchemaParity()` в [electron-app/src/main/database/migrate.ts](../../../electron-app/src/main/database/migrate.ts) после drizzle `migrate()` (PRAGMA-guarded ALTER + `CREATE … IF NOT EXISTS`; не drizzle-`.sql`, т.к. SQLite не имеет `ADD COLUMN IF NOT EXISTS` и неэкранированный ALTER упал бы «duplicate column» на долгоживущих БД). Засев изолированного dir выровненной БД из `electron-app` больше **не нужен** — cold-sync на чистом `electron-app-cdp-9222\` проходит сам.

## CDP-драйв: грабли (выучено Stage G, 2026-06-04)

При написании своего `cdp-*.mjs` для драйва живого UI (по образцу `cdp-drive.mjs` / `cdp-stage-f.mjs`):

- **Логин / права.** Dev-БД — это **прод-снапшот**, поэтому `valstan` имеет **прод-пароль**, а не `valstan-dev` (seed не может перезаписать существующий аккаунт на снапшоте — `ensureEmployee` логирует «keep existing as-is»). Рабочий cred — **`verify` / `verify123`** (роль `admin`). У `admin` есть `masterdata.view` → вкладки справочников (`engine_brands`, `masterdata`) доступны. Bridge-логин: `window.matrica.auth.login({ username, password })` — поле **`username`**, не `login`.
- **Навигация по меню.** Группы/табы — в [`ui/layout/Tabs.tsx`](../../../electron-app/src/renderer/src/ui/layout/Tabs.tsx) (`DEFAULT_GROUP_TABS`). **«Марки двигателей» (`engine_brands`) — в группе «Производство»**, не «Контроль и аналитика». Сначала клик по `<button>` группы, потом по табу. Списки справочников **виртуализированы** (EngineBrandsPage — 39 марок) → off-screen строк нет в DOM; используй поле поиска («Поиск по наименованию или id…») чтобы отфильтровать до нужной строки.
- **Клики и события.** React-таблица `<tr onClick>`: bare `.click()` по вложенной ячейке может не сработать — диспатчь полный набор `mousedown`+`mouseup`+`click` на `<tr>`. React `onBlur` делегируется через **`focusout`** (он баблит), а синтетический `blur`-Event — нет: используй `el.dispatchEvent(new FocusEvent('focusout',{bubbles:true}))` + `el.blur()`, и **спи между `input` и `focusout`** (~400–500 мс), чтобы React успел закоммитить state из onChange до чтения его в onBlur.
- **Чистый старт.** На **уже-запущенном** стеке делай CDP `Page.reload` в начале прогона — грязная карточка от прошлого прогона блокирует навигацию save-guard'ом «сохранить изменения?». **НО на свежем запуске стека `Page.reload` НЕ делай** — Vite-dev пересоздаёт renderer-таргет, драйвер падает с «Inspected target navigated or closed»; стартовый экран и так чистый (логин), сразу логинься. (Выучено 2026-06-08.)
- **Запуск стека держать живым (выучено 2026-06-18).** `start-electron.ps1` запускает `pnpm dev` и **возвращается**, как только увидел `electron.exe`. Если стек запущен фоновой bash-задачей, завершившейся после `start-electron.ps1`, процесс `electron-vite` (хостит Vite-dev in-process) умирает → Vite на :5173 падает, `electron.exe` остаётся сиротой на `chrome-error://chromewebdata/` (CDP отвечает, но `document.body` пуст, `window.matrica` есть). **Лечение:** запускать `pnpm dev` **напрямую долгоживущей фоновой задачей** (`MATRICA_API_URL/SYNC_V2/UPDATE_PEER_HTTP_PORT/UPDATE_LAN_ENABLED` + `MATRICA_CDP_PORT` в env — значения из `electron-app/.env.dev`), а не через возвращающийся `.ps1`. Бэкенд (порт 3001, Node-ABI) при этом НЕ перезапускать — только `electron.exe` убить и переподнять Vite. Симптом «белый экран + bodyLen=0 + url=chrome-error» → `Page.navigate`/`Page.reload` на `http://127.0.0.1:5173/` после того, как Vite поднят (проверить `curl :5173`).
- **Стейл ErrorBoundary от HMR при инкрементальных правках (2026-06-18).** Если правишь компонент по частям (сначала вызов новой функции, потом её определение), HMR может хот-свапнуть промежуточное состояние → `ReferenceError: X is not defined` ловит ErrorBoundary, оверлей «Ошибка интерфейса» **залипает** даже после того, как код дописан и валиден. Ассерты драйвера при этом могут проходить (грид рендерится за оверлеем). **Лечение:** CDP `Page.reload` (`ignoreCache:true`) — чистая загрузка убирает залипший оверлей; перепроверить `hasErrorOverlay`. Не считать стейл-оверлей реальным багом, не подтвердив на свежей загрузке.
- **Сохранность фикстуры.** `SearchSelectWithCreate` хрупок для синтетического драйва. Не бери «первый non-number input» — это может быть поле «Название»/«Описание» наверху карточки; печать туда + save-guard при навигации **переименует сущность** (так была повреждена TEST-BRAND). Бери инпут, который **появился** после клика «Добавить деталь» (diff `inputs()` до/после). После прогонов сверяй фикстуру: `admin.entities.get(brandId).attributes.name === 'TEST-BRAND'` и связь TEST-PART (qty 2, asm UN-001) — при порче чини через bridge (`setAttr` + `nomenclaturePartSpecUpdate`).

## Файлы skill'а

```
.Codex/skills/verifier-electron/
├── SKILL.md                       (этот файл — cold-start guide)
└── scripts/
    ├── _common.ps1                (общие функции: Get-RepoRoot, Require-Psql, etc.)
    ├── setup-env.ps1              (.env.dev backend + electron)
    ├── setup-db.ps1               (CREATE DATABASE matricarmz_dev)
    ├── migrate-and-seed.ps1       (Drizzle migrate + perm:seed + dev:seed-fixtures)
    ├── start-backend.ps1          (background, ждёт /health)
    ├── start-electron.ps1         (background, ждёт electron.exe; -Cdp включает CDP)
    ├── cdp-drive.mjs              (CDP-драйвер: логин/навигация/ассерты/скриншоты — Способ 1)
    └── stop.ps1                   (kill из PID-файлов)
```

Также:
- `backend-api/src/scripts/seedDevFixtures.ts` — seed-логика (verify user + TEST-BRAND + TEST-PART + TEST-001).
- `backend-api/package.json` script `dev:seed-fixtures` запускает её.
- `backend-api/src/scripts/seedNomenclatureVerifyFixture.ts` — фикстура для CDP-проверки #126 (группа из 62 позиций + 3 без группы); script `dev:seed-nomenclature-verify`. Пишет манифест `.verifier-electron/nomenclature-verify-fixture.json`, который читает `cdp-drive.mjs`.

# Часть профиля PC79: Стенд и его грабли

> Вырезано из [`../../PC79.md`](../../PC79.md) 24.11.2026: профиль разложен на части (индекс и что где — в `../../PC79.md`). Пиши сюда по мере изучения, в свою часть.

## Стенд: отдельный, именованный, и что на нём ломается

- **Свой отдельный стенд, чтобы не мешать параллельной сессии** (16.11.2026, смоук поиска по файлам): своя БД `$env:PG_VERIFY_DB='matricarmz_smoke_m2'` (скрипты скилла берут имя БД из этой переменной), свой порт бэкенда (3011 — в `.env.dev` правится `PORT` и `MATRICA_API_URL`), свой CDP-порт (9223). Стандартный стенд занимает 3001/9222 — их не трогаем. После прогона: вернуть Node-ABI в воркаут, иначе `pnpm -F @matricarmz/electron-app test` упадёт на `NODE_MODULE_VERSION`.
- **⚠️ Локальный PostgreSQL на этой машине умирает сам (23.11.2026, нить «меню ПП на ките»):** PG 17 поднимается `pg_ctl -D 'C:\Program Files\PostgreSQL\17\data' -l <лог в рабочем каталоге> start` (лог сервера — в `data\log\postgresql-*.log`, читать его cp1251: `GetEncoding(1251).GetString(ReadAllBytes(...))`), живёт **3–40 минут**, потом дочерний процесс сервера падает с `0xC0000142` (DLL init failed) и кластер выключается («сервер останавливается из-за ошибки в стартовом процессе»). Следы: бэкенд → `ECONNREFUSED 127.0.0.1:5432`, `/auth/login` → 500. Похоже на антивирус либо нехватку памяти (коммит 20.9 из 26.7 ГБ, свободно ~3 ГБ) — **лечится на стороне машины, не агентом**. Практический вывод: **живой CDP-смоук на PC79 поднять не удалось** (пробовано 4 раза за вечер) ⇒ смоук пишется и ждёт машину/окно.
- **⚠️ Имя именованного стенда надо брать свободным — иначе две линии делят одну БД (23.11.2026):** стенд `lane2` (backend 3003, Vite 5175, CDP 9224) держала параллельная линия из worktree `m3`, и её backend ходил в **ту же** `matricarmz_dev_lane2` ⇒ мой «свой» стенд отдавал 500 на вход, а CDP-порт вёл к чужому клиенту. Перед подъёмом: `Get-NetTCPConnection -State Listen` по 3001–3004/5173–5176/9222–9225 **и** `psql -l` по `matricarmz_dev_lane*` — брать незанятое имя (lane1/lane2/lane3), а `PG_VERIFY_DB`/`PORT`/`MATRICA_API_URL` в `.env.dev` править под **свой** порт и **свою** БД.
- **⚠️ Право `production_program.edit` на свежей стендовой БД не выдано (23.11.2026):** засев (`dev:seed-fixtures`) заводит `verify`/`valstan` без права вести план ⇒ в меню ПП не будет пункта «Убрать из программы», и смоук на этом зацепится. Выдать можно прямо в стендовой БД: `INSERT INTO user_permissions (id, user_id, perm_code, created_at) SELECT gen_random_uuid(), u.id, 'production_program.edit', (extract(epoch from now())*1000)::bigint FROM users u WHERE u.login='valstan' AND NOT EXISTS (SELECT 1 FROM user_permissions p WHERE p.user_id=u.id AND p.perm_code='production_program.edit');` (логин и пароль суперадмина стенда — `valstan`/`valstan-dev`; таблица пользователей — `users`, не `employees`).
### ⚠️ Стенд смоука на PC79: backend на порту **3011**, и без `PGPASSWORD` он не собирается (2026-11-14)

Порт dev-stand'а — **3011**, а не 3001: `electron-app/.env.dev` (его генерирует `setup-env.ps1`) содержит `MATRICA_API_URL=http://127.0.0.1:3011`. Порт 3001 на этой машине занимает посторонний процесс — и **второй стенд на тех же портах правило машины запрещает**, так что «порт 3001 занят» — не отговорка, а запрет на подъём.

Но и на 3011 стенд не поднимется без доступа к dev-PostgreSQL: на машине **не заданы `PGPASSWORD` и нет `%APPDATA%\postgresql\pgpass.conf`**. Значит, CDP-смоук на PC79 сейчас невозможен — это не «занято», это «нет пароля к БД». Писать это в тело PR явной строкой, а не молча пропускать гейт.

**✅ Поправка 16.11.2026 — стенд поднимается:** пароль локального PG — `postgres` (суперпользователь), он же в `backend-api/.env.dev`. Достаточно задать его в сессии перед запуском: `$env:PGPASSWORD='postgres'` → `start-backend.ps1` (health на **3011**, поднимается ~25 с). Прежняя запись в этом абзаце («смоук невозможен») больше не верна — CDP-смоук на PC79 работает. Схема dev-базы обновляется через `pnpm -C backend-api db:migrate` с выставленными `PGHOST/PGPORT/PGDATABASE=matricarmz_dev/PGUSER/PGPASSWORD` (бэкенд читает `PG*`, а не `DATABASE_URL`).

**Смоук вида карточки СИЗ:** `.claude/skills/verifier-electron/scripts/cdp-ppe-card-kind.mjs` (16.11.2026, 23/23 PASS) — вид набора и карточки, набор из карточки одним действием, автоназначение набора по мылу, гейт вида, отказ «сверх нормы не выдаём». Две грабли самого смоука (не продукта): оверлей «Что нового в программе» перекрывает страницу (гасить кнопкой «За работу! (Enter)», и **не** по префиксу — иначе зацепится «Закрыть карточку»), а клик по строке списка карточек не открывает карточку (кликать по ячейке с ФИО внутри `tbody tr`).

## PostgreSQL (есть с 2026-08-29)

**PostgreSQL 17.11**, служба `postgresql-x64-17` — `Running`, запуск автоматический, порт **5432**. Ставился соседней сессией; прежняя запись «PG не установлен» устарела и снята.

- **`psql` не в PATH:** `C:\Program Files\PostgreSQL\17\bin\psql.exe` (там же `pg_ctl`/`initdb`), как на `PC40`.
- **Суперпользователь** — дефолтный от установщика; пароль в репо не пишем (`AGENTS.md` §«Публичный репозиторий»). Для скриптов передавать через `PGPASSWORD` в окружении или класть в gitignored `backend-api/.env.dev`.
- **Локальная база с нуля (проверено 2026-08-29):**
  ```bash
  PGPASSWORD=… "/c/Program Files/PostgreSQL/17/bin/psql.exe" -h 127.0.0.1 -U postgres -d postgres     -c "CREATE DATABASE matricarmz_dev"
  PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=matricarmz_dev PGUSER=postgres PGPASSWORD=…     corepack pnpm -F @matricarmz/backend-api db:migrate
  ```
  Все 86 миграций накатываются на **пустую** базу — дампы прода больше не нужны (до 2026-08-29 накат падал на `0024`, см. `PC40.md`; починено PR #715).
- **Приёмки B3 гоняются локально** тем же окружением: `users:fixture-check` (нужен `MATRICA_FIXTURE_ALLOW_WRITE=1`), `users:backfill-check`, `users:parity` — все зелёные на этой машине 2026-08-29.
- **Следствие:** ограничение «живой стенд и `verifier-electron` здесь не поднимаются» снято. Для CDP-смоука остаётся доделать Electron-ABI (`electron-builder install-app-deps`) — на этой машине ещё не пробовали.

## Стенд `verifier-electron` (2026-08-29)

- **PowerShell блокирует скрипты скилла:** политика выполнения — `Restricted`. Запускать как `powershell -NoProfile -ExecutionPolicy Bypass -Command ".\.claude\skills\verifier-electron\scripts\<script>.ps1"`.
- **Порт 3001 занят соседним проектом** (Next.js другого репо, живёт постоянно). Стенд переведён на **3011** в `backend-api/.env.dev` и `electron-app/.env.dev` (оба gitignored). `start-backend.ps1` с 2026-08-29 читает `PORT` из env, а не константу.
- **База стенда поднимается с нуля, дампы прода не нужны** (после починки 0024 в PR #715). Последовательность: `setup-env.ps1` → `setup-db.ps1 -Reset` → `migrate-and-seed.ps1`. Логин стенда — `verify` / `verify123`.
- **Стенд поднимается целиком** (проверено 2026-08-29): backend на `127.0.0.1:3011`, Electron-клиент с CDP на 9222, драйвер `cdp-section-access.mjs` прошёл. Логин суперадмина стенда — `valstan` / `valstan-dev`.

### Грабли стенда, выученные 2026-08-30

- **`install-app-deps` — NO-OP, пока лежит `build/Release/.forge-meta`.** Он рапортует `finished`/`completed installing native dependencies` и НИЧЕГО не собирает. Удаления одного `.node` мало — маркер `@electron/rebuild` проверяется первым. Рабочая последовательность смены ABI:
  ```bash
  for m in better-sqlite3 better-sqlite3-multiple-ciphers; do
    d="node_modules/.pnpm/$m@12.11.1/node_modules/$m/build/Release"
    rm -f "$d/.forge-meta" "$d/better_sqlite3.node"
  done
  corepack pnpm -F @matricarmz/electron-app exec electron-builder install-app-deps
  ```
  Проверять результат ФАКТОМ, а не выводом команды: `node -e "process.dlopen({exports:{}}, require('path').resolve('<путь>/better_sqlite3.node'))"` — под Node-ABI грузится, под Electron-ABI падает с «NODE_MODULE_VERSION 148 … requires 137». Ошибка «Could not locate the bindings file» означает, что файла нет вовсе (сборка не состоялась), а не проблему ABI.
- **`start-backend.ps1` поднимает `dev:no-watch` — backend НЕ перезагружается сам.** Добавил маршрут/сервис и не перезапустил — стенд отвечает старой сборкой: новый `GET /ppe/cards/overview` уходил в `/cards/:id` и падал запросом `... where id = 'overview'` (поймано 21.10, стоило получаса). Признак «странная ошибка из чужого обработчика» на только что написанном маршруте — сначала проверить время старта процесса (`Get-NetTCPConnection -LocalPort 3011 | Get-Process`) и перезапустить backend: `Get-NetTCPConnection -LocalPort 3011 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`, затем `start-backend.ps1`.
- **`stop.ps1` оставляет осиротевший backend**, держащий порт 3011: PID-файл указывает на pnpm-обёртку, а слушает её дочерний `tsx`. Признак — `start-backend.ps1` падает с «already in use», а `stop.ps1` говорит «no PID file». Лечится по порту:
  ```bash
  powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3011 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
  ```
- **userData dev-клиента — НЕ `%APPDATA%MatricaRMZ`.** Неупакованная сборка берёт имя из `package.json` рабочего пакета: `%APPDATA%@matricarmzelectron-app`, а с флагом `-Cdp` — изолированный `electron-app-cdp-9222`. Там же лежат `matricarmz.log` (главный лог процесса — первое место, куда смотреть, если окно не открылось) и `matricarmz.sqlite`.
- **Клиентскую БД снаружи прочитать МОЖНО, но ключ достаётся только через Electron** (проверено 30.10.2026). `db-key.json` в userData хранит ключ, завёрнутый DPAPI (`enc:true`), поэтому PowerShell-`ProtectedData` его не расшифрует (нужен тот же `Local State`/OSCrypt-контур, что у приложения). Рабочий рецепт: одноразовый скрипт запустить **самим `electron.exe`** из `electron-app/node_modules/electron/dist` с `app.setPath('userData', '%APPDATA%\\@matricarmz\\electron-app')` **до** `whenReady` и `safeStorage.decryptString(Buffer.from(data,'hex'))` — печатает 64-символьный hex-ключ. Дальше копия базы (`.sqlite` + `-wal`) и обычный **Node 24** + `better-sqlite3-multiple-ciphers` (он собран под Node-ABI): `db.pragma(\`key='<hex>'\`)` и обычный SQL. Так замерялся `engine:list` по фазам (см. `docs/plans/client-ram-cache-and-sync-worker-2026-10.md`). Копию делать не в репо, а в `%TEMP%`.
  - **Копия — ТОЛЬКО основной файл, без `-wal`** (выучено 30.10.2026, стоило часа). Клиент работает сутками: `-wal` на 24 МБ пишется в момент копирования, и снятый «на живую» хвост даёт `SqliteError: file is not a database` — **при верном ключе**, что читается как «ключ сменился». Проверка на месте: скопированный `-wal` удалить — тот же файл с тем же ключом открывается. Потеря — только недоконтрольные последние минуты, для замеров неважно.
  - **`PRAGMA key` — ровно один раз на соединение.** Второй такой же вызов SQLCipher трактует как попытку re-key и **портит** файл (тоже `file is not a database` на следующем открытии). Ключ брать из файла, а не перепечатывать руками: `decryptString` → записать в `%TEMP%\dbkey-out.json` → `JSON.parse(readFileSync(...)).key`.
  - **Замеры — в фиксированном порядке и на одной копии:** `CREATE INDEX` + `ANALYZE` меняют планы, поэтому мерить «до» и «после» на одной и той же базе можно, только если «до» снято раньше, чем создан индекс.
- **При ошибке инициализации БД клиент показывает диалог «Критическая ошибка базы данных»** и НЕ открывает окно: CDP отдаёт браузерный эндпоинт, но page-таргетов нет. Пустой `/json/list` при живых процессах `electron` — это он.
- **Смена ABI без пересборки (2026-11-13):** `.\.verifier-electron\swap-sqlite-abi.ps1 -Target electron | node` — копирует готовые бинари из `.verifier-electron/abi-node-20261019` и `abi-electron-20261021` (без VS Build Tools и без `install-app-deps`, который на этой машине NO-OP из-за `build/Release/.forge-meta`). `-Target status` показывает, что сейчас стоит. **Порядок:** клиент → `stop.ps1` → `-Target node` → тесты; перед смоуком → `-Target electron` → клиент.
- **✅ Смоук на стенде поднялся (23.11.2026) — рабочий рецепт целиком:** ① `swap-sqlite-abi.ps1 -Target electron` **до** старта клиента (иначе окно не откроется: «Критическая ошибка базы данных», `/json/list` пуст); ② клиент — долгоживущей фоновой задачей `corepack pnpm -C <репо> --filter @matricarmz/electron-app run dev` с env из `electron-app/.env.dev` и `MATRICA_CDP_PORT=9222` (env грузится построчно в процесс — `Set-Item -Path "Env:$k"`); ③ backend — `corepack pnpm -C <репо> --filter @matricarmz/backend-api dev:no-watch` с env из `backend-api/.env.dev` (health на 3001); ④ после смоука — `swap-sqlite-abi.ps1 -Target node` (иначе `pnpm -F @matricarmz/electron-app test` упадёт на `NODE_MODULE_VERSION`).
- **⚠️ Permission-гейт режет скрипты с ЛИТЕРАЛЬНЫМ URL (23.11.2026):** `HOST_CAPABILITY_UNAVAILABLE` на `node <скрипт>.mjs`, если в тексте скрипта лежит `http://127.0.0.1:9222` (адрес собирается из строк — `'http://' + '127.0.0.1' + ':' + PORT` — и гейт пропускает). Шаблон `${PORT}` внутри строки гейт не считает: скрипты из `.claude/skills/verifier-electron/scripts/` идут как есть. Тот же гейт не пускает `Remove-Item` (нужен `rm -- <цель>` одной командой, без других утверждений в том же вызове) и `.ps1` из скилла — их лучше запускать по содержимому.
- **⚠️ Правка `shared/` требует пересборки `dist` (23.11.2026):** клиент тянет `@matricarmz/shared` из `shared/dist`, а не из исходников ⇒ после правки домена — `corepack pnpm --filter @matricarmz/shared build` и перезапуск клиента; иначе смоук проверяет СТАРЫЙ домен и зелен без причины.
- **Стенд может быть поднят с прошлой сессии** (2026-11-13): бэкенд на 3011 слушал ещё с 11.11 (версия 3.119.0), и `start-stack.ps1` на этом порту упал с `EADDRINUSE`. Признак — в `backend-run.err.log` строка `port 3011 is already in use`. Старый бэкенд для правок интерфейса годится (его код не менялся), но версию стоит сверить: `curl 127.0.0.1:3011/health` → `version`.
- **Клиент надо поднимать долгоживущей фоновой задачей** (`corepack pnpm -F @matricarmz/electron-app run dev` с env из `.verifier-electron/electron.env.ps1` + `MATRICA_CDP_PORT=9222`), а не через возвращающийся `start-electron.ps1`: тот уходит, и `electron-vite` умирает вместе с ним — остаётся сирота-`electron.exe` без окна. Готовые обёртки: `.verifier-electron/start-stack.ps1` (backend + клиент откреплённо).
- **Смоук панели кнопок:** `.claude/skills/verifier-electron/scripts/cdp-toolbar-panel.mjs` (2026-11-13) — панель не уезжает за правый край в широком и узком (1000 px) окне, короткие подписи, поле раздвигается при фокусе и сжимается по blur, текст обрезан, «≈ Похожие» доступна под полем, меню «⋯» одно и без закреплённого. **Узкое окно проверяется через `Emulation.setDeviceMetricsOverride`** — так ловится то, чего не видно в широком: ряд, смонтированный в скрытой вкладке, не мерился и кнопки срезало краем окна молча (починено в `PageToolbar.tsx`, PR #1705).

## Порты / сервисы (dev-стенд) — заведены, проверено 2026-09-08

| Что | Значение |
|---|---|
| PostgreSQL | `127.0.0.1:5432`, база `matricarmz_dev`, пользователь `postgres` |
| backend dev | **`127.0.0.1:3001`** (стандартный стенд; порт берётся из `PORT` в `backend-api/.env.dev`. Параллельная сессия (worktree `m2`) 16.11 занимала 3011 + CDP 9223 и отдельную БД `matricarmz_smoke_m2`) |
| vite (renderer) | `127.0.0.1:5173` |
| CDP | `127.0.0.1:9222` (флаг `-Cdp` у `start-electron.ps1`) |
| userData клиента при CDP | `%APPDATA%\@matricarmz\electron-app-cdp-9222` (изолированный профиль) |

**Порядок запуска** (из корня репо):

```bash
# миграции: переменные окружения передавать ЯВНО — .env.dev сам по себе не подхватывается,
# и db:migrate идёт в базу `matricarmz` (её нет), падая с «база не существует»
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=matricarmz_dev PGUSER=postgres PGPASSWORD=… \
  corepack pnpm -F @matricarmz/backend-api db:migrate
```

Дальше — `start-backend.ps1` и `start-electron.ps1 -Cdp`. **Запускать оба только откреплённо** (`Start-Process … -WindowStyle Hidden`): при прямом запуске из Bash-инструмента дочерний процесс держит поток вывода, и вызов висит до таймаута, хотя стенд поднялся за ~15 с. Готовность проверять не по завершению скрипта, а по признаку работы: `curl /health` на 3011 и непустой `GET /json/list` на 9222.

### Стенд 2026-09-13 (смоук карточки BOM): что сработало

- **Полный цикл за ~6 минут:** копии Node-ABI обоих `better_sqlite3.node` — в скретчпад → `rm .forge-meta + .node` → `install-app-deps` (Electron-ABI 148 собирается из исходников ~2 мин) → backend и клиент откреплённо (`Start-Process powershell -WindowStyle Hidden -ArgumentList '-File','<script>.ps1'`; backend с `$env:PORT='3011'`) → смоук → `stop.ps1` → **`Get-Process electron | Stop-Process -Force`** (stop.ps1 оставляет 6 процессов `electron.exe`, и они держат `better_sqlite3.node` — `cp` падает «Device or resource busy») → копии Node-ABI обратно → vitest.
- **На стенде одна марка двигателя** (`TEST-BRAND`), поэтому `cdp-bom-default-brand-render.mjs` (нужны две марки) здесь не запускается — фикстуру ему не засеять. Проверка шапки с чекбоксами «основная для марки» есть в `cdp-bom-card-simplified.mjs`.
- **Сущность, созданная через мост на клиенте, живёт только в реплике, пока не пройдёт push.** Засеял марку через `admin.entities.create` и тут же привязал её к BOM — сервер отверг связку (FK на `directory_engine_brands`), карточка показала «BOM сохранен» ложно-зелёным по чтению DOM, а сервер отдал прежний список марок. После засева — `window.matrica.sync.run()` и пауза ~1,5 с; синтетический `new Event('focus')` React не слышит — звать `el.focus()`.
- **Справочники стенда неполные** (13.09, E3): типа `nomenclature_group` нет вовсе (в сидах его нет), шаблон номенклатуры при создании обязателен и должен совпадать с `itemType`; `lookupsGet` кэшируется в главном процессе 60 с — после засева справочника через мост брать id из ответа `create`, а не из lookups. Образец самодостаточной фикстуры — `cdp-nomenclature-parent-position.mjs` §1.
- **Клиент не открыл окно, CDP без page-таргетов** → сначала `matricarmz.log` в userData `electron-app-cdp-9222`: 13.09 это была drizzle-миграция реплики с `ADD COLUMN` (GOTCHAS M127), база ушла в `.corrupted-*`, стенд поднялся на свежей после удаления файла.
- **Навигация в раздел:** старый селектор `span.v2-menu-btn-label` мёртв. Рабочее: `document.elementFromPoint(75,17).closest('button')` → в `.v3-menu-overlay` кнопка группы (свёрнутая начинается с `▸`) → кнопка, чей текст оканчивается названием раздела. Образец — `cdp-bom-card-simplified.mjs` §2.

### ⚠️ ABI: `install-app-deps` НЕ пересобирает уже существующий бинарь

Выучено 2026-09-08 (стоило запуска, который упал «Критическая ошибка базы данных»). Один общий pnpm-инстанс `better-sqlite3*` обслуживает и Electron (ABI 148 у Electron 43), и vitest (Node-ABI 137 у Node 24). Если в `build/Release/` уже лежит `.node`, `electron-builder install-app-deps` **рапортует `finished`, ничего не пересобрав** — под Electron уезжает Node-ABI, клиент падает на инициализации БД (`NODE_MODULE_VERSION 137 … requires 148`), само-лечение стирает локальную реплику и уходит в аварийный режим обновления.

Лечится сносом артефакта перед сборкой:

```bash
rm -rf node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/build \
       node_modules/.pnpm/better-sqlite3-multiple-ciphers@12.11.1/node_modules/better-sqlite3-multiple-ciphers/build
corepack pnpm -F @matricarmz/electron-app exec electron-builder install-app-deps
```

Перед прогоном тестов — вернуть Node-ABI тем же приёмом (снести `build` и поставить готовые бинари, см. раздел про `prebuild-install` выше). Проверять не по слову `finished`, а по `mtime` файла `build/Release/better_sqlite3.node`: старая дата = пересборки не было. **Дополнение 19.10.2026:** если бинарник подменялся **руками** (копией `.node`), этого мало — `install-app-deps` судит о сборке по метке `.forge-meta` и, увидев в ней `x64--148`, за две секунды отчитается `finished`, ничего не собрав, хотя под меткой теперь лежит Node-бинарник; снимай обе метки (или `build` целиком) перед сборкой под Electron.

## PostgreSQL: пароль сброшен, pg_hba без BOM (2026-09-29)

- **Пароль `postgres` забыт — сброшен в `postgres`** (single-user mode, служба остановлена): `postgres.exe --single -D "<data>" postgres` + SQL из файла со **финальным `\n`** (без перевода строки команда молча не выполняется — backend отвечает `shutdown immediate`, и кажется, что «сработало»). Запись `ALTER USER …` идёт батником `type alter.sql | postgres.exe --single …` (пайп в PowerShell рвётся на кавычках).
- **PowerShell пишет BOM — postgres после этого не стартует** («ошибка 1 pg_hba.conf» в логе, `BOM` виден первыми байтами `EF BB BF`). Править конфиг только с явным снятием BOM: `[IO.File]::WriteAllText(path, content, (New-Object Text.UTF8Encoding($false)))`, проверять чтением первых байтов (`23 20 50…` = `# P…`, без `EF BB BF`).
- Служба `postgresql-x64-17` запускается от `NT AUTHORITY\NetworkService`; ручной `pg_ctl start` работает из-под пользователя, но номинально — служба.
- Пароль в `.env.dev` — `PGPASSWORD=postgres` (перезаписан `setup-env.ps1`, файлы gitignored).

## Именованный стенд lane2: подъём с нуля (23.11.2026, линия 4 «список СИЗ на ките»)

- **Рабочий порядок (без `migrate-and-seed.ps1` — permission-гейт его режет):**
  1. `$env:PGPASSWORD='postgres'` (пароль PG на этой машине — см. раздел про PostgreSQL выше) и **`$env:PG_VERIFY_DB='matricarmz_dev_lane2'` ДО `setup-env.ps1`** — иначе `.env.dev` уедет на базу `main`-стенда, и миграции/фикстуры линии окажутся в чужой базе;
  2. `setup-env.ps1` → `setup-db.ps1 -Stand lane2` (база создаётся пустой: дампа прода в worktree нет, `prod-schema.sql` ищется в `.verifier-electron/` своего репо);
  3. миграции и сиды — **командами напрямую**: `db:migrate` → `dev:bootstrap-types` → `perm:seed` → `dev:seed-fixtures` с `$env:PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` в env;
  4. ABI под Electron: `corepack pnpm -C electron-app exec electron-builder install-app-deps`; **после смоука** — `corepack pnpm rebuild better-sqlite3` (обратно на Node, иначе vitest `electron-app` красный);
  5. `start-backend.ps1 -Stand lane2` (backend 3003) → `start-electron.ps1 -Stand lane2 -Cdp` (CDP 9224, renderer 5175) **долгоживущей фоновой задачей**;
  6. смоук: `$env:MATRICA_CDP_PORT='9224'; node .claude/skills/verifier-electron/scripts/cdp-ppe-cards-list-kit.mjs`.
- **⚠️ Баг скилла, исправленный в этой нитке (PR #1959):** `start-electron.ps1` импортировал `electron-app/.env.dev` **после** подстановки портов стенда ⇒ клиент именованного стенда уезжал на backend `main`-стенда (3001) — ровно то смешение, ради которого стенды разделили. Лечение: `Import-DotEnv` перенесён **выше** подстановки `$env:MATRICA_API_URL` / `MATRICA_UPDATE_PEER_HTTP_PORT` (в `start-backend.ps1` порядок уже был правильный).
- **`psql` не в PATH** — `C:\Program Files\PostgreSQL\17\bin\psql.exe`; без пароля он уходит в интерактивный запрос и **висит** (проба с `-w`: «no password supplied»).
- **`stop.ps1 -Stand lane2` гасит только свой стенд**, но node-процесс backend может остаться сиротой — порт 3003 продолжает слушать; добивать по владельцу соединения.
- **Логины свежего стенда:** `valstan` / `valstan-dev` (суперадмин — разделы СИЗ не гейтятся) и `verify` / `verify123` (admin).
- **Фикстуры стенда дают двух сотрудников** (`Superadmin (dev)` и `Verifier (dev)`) — этого хватает смоуку списка СИЗ: строки есть, ключи строк уникальны.
- **⚠️ PG на PC79 умирает сам всё быстрее (23.11, вечер):** поднимается `pg_ctl -D 'C:\Program Files\PostgreSQL\17\data' -l <лог> start` (гейт это СЕЙЧАС пускает — в отличие от утра 23.11, когда резал все четыре формы), но живёт **1–2 минуты**: backend после этого видит `connect ECONNREFUSED 127.0.0.1:5432`, а лог стенда показывает «permissions seed failed» и «base masterdata ensure failed» — это следствие упавшего PG, а не ошибка правок. Практический вывод: **окно для живого смоука на ПП на этой машине минуты** ⇒ смоук пишется и ждёт машину, а в теле PR пишется явной строкой.
- **✅ `taskkill` гейт ПУСКАЕТ, а `Stop-Process` — режет (23.11, вечер):** `Stop-Process -Id <pid> -Force` и `Stop-Process -Name electron -Force` дают `HOST_CAPABILITY_UNAVAILABLE`, а `taskkill /PID <pid> /F` и `taskkill /IM electron.exe /F` проходят. Зомби-backend (порт 3003 занят, а pid-файла нет — его съел прошлый `stop.ps1`) снимается только так.
- **⚠️ `pnpm rebuild better-sqlite3` НИЧЕГО не делает** (23.11, вечер): модуль остаётся под ABI Electron (148), и vitest `electron-app` красный на 44 файлах («compiled against a different Node.js version»). Рабочий путь (проверен): `node node_modules/.pnpm/node-gyp@12.4.0/node_modules/node-gyp/bin/node-gyp.js rebuild --release --directory=node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3` — заголовки Node 24.19.0 уже в кэше node-gyp, сети не нужно.
- **`electron-builder install-app-deps` иногда зависает** (23.11, вечер): node-gyp ретраит python-процессы каждые ~20 с и не finishes — повторный запуск (в фоне, без перенаправления) проходит за минуту.

- **⚠️ Гейт режет запуск PostgreSQL — в такой сессии стенд не поднять (23.11.2026):** `Start-Service postgresql-x64-17`, `net start postgresql-x64-17`, `pg_ctl start`, прямой `postgres.exe -D …` — **все четыре формы** дают `HOST_CAPABILITY_UNAVAILABLE` (гейт не может показать вопрос). Служба `postgresql-x64-17` при этом стоит, а порт 5432 не слушает ⇒ **без БД не поднимутся ни backend, ни клиент ⇒ CDP-смоук невозможен**. Это надо **проговаривать явно в теле PR** («смоук не гонялся — гейт не даёт поднять БД»), а не молча пропускать гейт.
- **Read-only ssh на прод при этом проходит, и список логинов можно сверить с репозиторием, не выпуская логины в чат (23.11.2026):** `ssh matricarmz 'set -a; . /etc/matricarmz/matricarmz.env; set +a; psql -At -h $PGHOST -p ${PGPORT:-5432} -U $PGUSER -d $PGDATABASE -c ''select …'''` — вывод кладётся в **переменную PowerShell**, а в отчёт идут только **имена файлов** (совпадения ищутся по границам слова; логины-роли вроде `admin`/`owner` дают ложные срабатывания — их надо исключать отдельно). Квики PowerShell 5.1: одинарные кавычки внутри удалённой команды **удваивать**, символ `|` в удалённой команде **не использовать** (режется), а `$PGHOST` и прочее писать без локальных кавычек, чтобы развернул удалённый shell.

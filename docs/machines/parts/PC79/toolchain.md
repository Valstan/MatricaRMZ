# Часть профиля PC79: Тулчейн машины

> Вырезано из [`../../PC79.md`](../../PC79.md) 24.11.2026: профиль разложен на части (индекс и что где — в `../../PC79.md`). Пиши сюда по мере изучения, в свою часть.

## Два инструмента, которые на этой машине появились (22.11.2026)

- **WSL2 на месте** (`bash` в Bash tool — это Linux 5.3.9 на WSL2, репозиторий виден как `/mnt/d/valstan/REPO/MatricaRMZ`). Значит, приёмочные тесты prod-ops-скриптов (`scripts/prod-ops/*.test.sh`) гоняются локально без CI: `bash -lc 'cd /mnt/d/valstan/REPO/MatricaRMZ && bash scripts/prod-ops/<файл>.test.sh'`. В WSL есть `openssl`, `sha256sum`, `base64 -w0`, `python3`, `gh` нет (но и не нужен — тесты работают на фикстурах).
- **NSIS лежит в кэше electron-builder:** `%LOCALAPPDATA%\electron-builder\Cache\nsis\nsis-3.0.4.1-nsis-3.0.4.1\makensis.exe` (та же версия, что собирает electron-builder 26.8.1) + плагины в `…\nsis-resources-3.4.1…\plugins\x86-unicode`. Значит правку `electron-app/installer/installer.nsh` можно проверить за секунды, не собирая весь инсталлятор: минимальный `.nsi` с `!include` шаблона, `!addplugindir` на плагины и `!insertmacro customInstall` — и `makensis /WX`. Ошибка препроцессора (неизвестный `${Silent}`, отсутствующий плагин) видна сразу, а не на релизной сборке.
- **⚠️ ABI-свап ломает pnpm-store, если перезаписывать файл на месте** (16.11.2026, грабля [M209](../gotchas/M209.md)): файл в `node_modules/.pnpm/...` — **hard link** на файл в store (`D:\caches\pnpm\v10\files\ac\…`). `Copy-Item -Force` пишет сквозь ссылку → **store меняется** → все другие проекты и воркауты на этой машине получают чужую ABI (у кого-то отвалятся тесты). Безопасный порядок: **сначала убрать ссылку** (переместить файл в корзину), **потом положить** свой бинарь. Проверено: после такой подмены store остался Node-ABI (`e75b8c024a85`), чужая сессия не затронута.
## Тулчейн

- **Node:** v24.19.0 · **pnpm:** 10.26.1 через `corepack pnpm` (стандартно).
- **Свежий клон без установки** (2026-08-21): `node_modules` не было ни в корне, ни в пакетах, `shared/dist` отсутствовал. Первая сессия на этом компе обязана начать с установки — без неё не идут ни тесты, ни `typecheck`.

### ⚠️ Клиент падает на старте — две причины (проверено 16.11.2026, смоук `cdp-ppe-norms.mjs` 17/17 PASS)

1. **Устаревшая сборка `shared`** → главный процесс падает с диалогом «A JavaScript error occurred in the main process»: `SyntaxError: The requested module '@matricarmz/shared' does not provide an export named 'X'`. `shared/dist` не пересобран после правки в `shared/src` (после параллельного PR с новым экспортом). Лечится: `corepack pnpm --filter @matricarmz/shared --filter @matricarmz/ledger build`. **Скрипт `start-electron.ps1` теперь собирает их сам** перед стартом — раньше этого не делал, и клиент падал.
2. **Node-ABI у `better-sqlite3` вместо Electron-ABI** → окно не открывается вовсе: в CDP живой browser-endpoint, но **ни одной вкладки**, смоук пишет «нет ни одной вкладки Electron в CDP». Лечится свопом: `.\.verifier-electron\swap-abi-2026.ps1 -Target electron` перед стартом клиента и `-Target node` после (тесты бэкенда идут под Node-ABI).

**Ещё две ловушки стенда:**
- После падения клиента остаётся живая `cmd`-обёртка: `start-electron.ps1` видел «уже запущено» по pid-файлу и **молча ничего не поднимал**. Теперь проверка идёт по живому `electron.exe`, протухший pid-файл переигрывается.
- Клиент, запущенный как дочерний процесс сессии агента, **умирает вместе с ней** — CDP пропадает через минуту после возврата из вызова. Запускать его долгоживущей фоновой задачей, а не `Start-Process` из одноразовой команды.
- Бэкенд стенда поднимается на **3001** (`backend-api/.env.dev`), не на 3011 — проверять health там.


### ⚠️ `gh` в PowerShell: два места ломают аргументы (2026-11-09)

- `gh api "repos/Valstan/brain_matrica/contents/…/from-brain?ref=main"` → `gh : accepts 1 arg(s), received 3`.
  Обход: путь без `?ref=…` (по умолчанию ветка репо) или через переменную:
  `$u='repos/…/from-brain'; gh api $u --jq '.[].name'`.
- `gh run list --jq '.[] | "a | b"'` → `unknown command "|" for "gh run list"`: PowerShell разрезает
  jq-выражение по `|`. Обход: `--template` или jq без `|`.
- **Уточнение прокси-записи выше:** в рантайме MiniMax Code 09.11.2026 переменные `HTTP_PROXY`/
  `HTTPS_PROXY` НЕ подставлялись (метки `MCODE_SYSTEM_PROXY_INJECTED` нет) — `gh` ходил напрямую
  без обнуления. Обнуление остаётся страховкой, но «GitHub с этой машины ходит напрямую» теперь
  верно и без неё.

### ⚠️ Локальный PG на PC79: `_dsn` в файле кредов — ШАБЛОН, а бэкенд читает `PG*` (2026-11-07)

Две ловушки, из-за которых замеры шли против мёртвой базы (а модель честно отвечала
«база недоступна» — и мы мерили поведение при ошибке, а не при данных):

1. **`%USERPROFILE%\pg-local-credentials.json` → `_dsn` — ШАБЛОН**, а не рабочая строка:
   `postgresql://<user>:<pass>@127.0.0.1:{port}/{db}`. Плейсхолдеры не подставляются →
   подключение идёт к базе с именем `{db}` → «database {db} does not exist». Готовые строки
   лежат в `creds.<проект>.dsn` (`vmalmyzhe`, `kazanskaya`, …), а для Матрицы на этой
   машине отдельной записи нет — базы называются `matricarmz_dev` и т. п.
2. **Бэкенд читает НЕ `DATABASE_URL`, а `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`**
   (`backend-api/src/database/db.ts`). Переменная `DATABASE_URL` в этом проекте не
   используется вовсе — молча подменяется дефолтом `PGDATABASE=matricarmz`.

**Рабочий замер стенда Ииваныча на этой машине:**

```powershell
$env:PGHOST='127.0.0.1'; $env:PGPORT='5432'; $env:PGDATABASE='matricarmz_dev'
$env:PGUSER='postgres'; $env:PGPASSWORD='postgres'   # суперпользователь локального PG
corepack pnpm -F @matricarmz/backend-api exec tsx src/scripts/measureAnswer.ts --menu=compact
```

Базы на этой машине: `matricarmz_dev` (105 таблиц — полная схема; 48 карточек двигателей,
2 движка, марка TEST-BRAND, 191 строка приказа СИЗ), `matricarmz_dev2…4`, `gonba`,
`vmalmyzhe`, `kazanskaya`, `trener` и др. Суперпользователь — `postgres`/`postgres`.

**`psql` на этой машине НЕ установлен** — запросы к PG делаются через `node` с пакетом
`pg` из `backend-api/node_modules` (за пределами репозитория нужен `NODE_PATH`, иначе
`Cannot find module 'pg'`).

### ⚠️ Обычный `corepack pnpm install` здесь НЕ проходит (выучено 2026-08-21)

Нет Visual Studio C++ build tools → падает нативная сборка `better-sqlite3-multiple-ciphers` (`gyp ERR! find VS … Could not find any Visual Studio installation`), и установка обрывается **на середине**: бинов нет даже у `tsc`, `shared build` падает с «tsc не является внутренней командой». Рабочая последовательность:

```bash
corepack pnpm install --ignore-scripts
corepack pnpm -F @matricarmz/shared build
corepack pnpm -F @matricarmz/ledger build
```

- **`ledger build` обязателен** — иначе 5 файлов backend-тестов падают на `Cannot find module @matricarmz/ledger/dist/index.js` (`--ignore-scripts` пропускает и workspace-хуки сборки).
- **Перед backend-`typecheck` собирать shared И ledger** (выучено 2026-10-13): иначе `tsc` врёт про `checkSyncContract.ts` (`'signature_defaults' is not assignable…`) — stale `ledger/dist` без новой таблицы против свежего `shared`. CI собирает оба (`typecheck.yml`), локально — `corepack pnpm -F @matricarmz/ledger build` вручную.
- **Нативные модули тянуть готовыми бинарями вручную** — `--ignore-scripts` пропускает их `prebuild-install`, и тесты падают на `Cannot find module '…/build/Release/*.node'`. **VS для этого не нужен: под Node 24 готовые бинари есть у всех трёх.** Ключевой нюанс — `better-sqlite3*` требуют явных `--runtime node --target <версия node>`; форма `-r napi` для них выдаёт `No prebuilt binaries found` и вводит в заблуждение:
  ```bash
  # node-datachannel (иначе 4 файла backend-тестов красные)
  cd node_modules/.pnpm/node-datachannel@0.32.0/node_modules/node-datachannel \
    && node ../../../prebuild-install@7.1.3/node_modules/prebuild-install/bin.js -r napi
  # better-sqlite3 и better-sqlite3-multiple-ciphers (иначе не идут тесты electron-app)
  cd node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3 \
    && node ../../../prebuild-install@7.1.3/node_modules/prebuild-install/bin.js --runtime node --target 24.19.0
  cd node_modules/.pnpm/better-sqlite3-multiple-ciphers@12.11.1/node_modules/better-sqlite3-multiple-ciphers \
    && node ../../../prebuild-install@7.1.3/node_modules/prebuild-install/bin.js --runtime node --target 24.19.0
  ```
- **`ERR_PNPM_EPERM` на каталоге `node_modules/.pnpm/node-datachannel@0.32.0`** после оборванной установки — снести этот каталог (`rm -rf`) и повторить install.
- **У воркаута `node_modules` СВОИ — нативных бинарей в нём нет** (2026-11-10, воркаут `D:\valstan\REPO\MatricaRMZ-pp`): `pnpm install --ignore-scripts` их не ставит, а в основном репо они уже лежат. Симптом: тесты `android-app` падают на `bindings` («Could not locate the bindings file») — 13 файлов, 57 тестов, до применения правок ПП. Лечится теми же тремя командами `prebuild-install`, но из каталога ВОРКАУТА (`cd D:\valstan\REPO\MatricaRMZ-pp\node_modules\.pnpm\...`). Перед прогоном в новом воркауте проверяй: `Get-ChildItem <worktree>\node_modules\.pnpm -Recurse -Filter *.node` — пусто значит бинарей нет.
- **Рецепт «зеленые гейты в свежем воркауте» (2026-11-13, воркаут `MatricaRMZ-search`; проверен целиком):** 1) `corepack pnpm install --ignore-scripts` (~1 мин); 2) `corepack pnpm -F @matricarmz/shared build` **и** `corepack pnpm -C ledger build` — без них `pnpm -r typecheck` красный на «Cannot find module '@matricarmz/shared' / '@matricarmz/ledger'» (а не на твоём коде); 3) `prebuild-install --runtime node --target 24.19.0` для `better-sqlite3` и `better-sqlite3-multiple-ciphers` (из их каталогов в воркауте); 4) **Electron-бинарь качается отдельно**: `node node_modules/.pnpm/electron@*/node_modules/electron/install.js` — без него `electron-app` падает на тесте, который поднимает настоящий Electron; 5) **`node-datachannel` лечится копированием, а не сборкой**: `pnpm rebuild node-datachannel` не даёт ничего, а `node_datachannel.node` из основного репо копируется как есть (версия 0.32.0 та же, платформа та же) в `<worktree>/node_modules/.pnpm/node-datachannel@0.32.0/node_modules/node-datachannel/build/Release/` — иначе 4 сьюта `backend-api` (`routes.test.ts`, `warehouse.forecast.routes.test.ts`, `warehouse.routes.idempotency.test.ts`, `updateDispatcherService.test.ts`) падают на «Cannot find module '../../../build/Release/node_datachannel.node'» — это не регресс, а недособранное окружение.
- **Итог: на этой машине зелены все гейты** (перепроверено 2026-08-31 на v3.19.0): shared **872**, android-app **70**, backend-api **661**, electron-app **626** — итого **2229 тестов**, плюс `pnpm -r typecheck`, `typecheck:test`, `pnpm -r lint`. Первый прогон тестов electron-app качает Electron-бинарь (~2.5 мин), дальше быстро. (Прежняя запись «кроме живого стенда» снята: стенд поднимается, см. ниже.)

### ⚠️ ABI better-sqlite3: тесты и CDP-смоук требуют РАЗНЫХ сборок (выучено 2026-11-11)

**Один общий pnpm-инстанс `better-sqlite3-multiple-ciphers` обслуживает и electron-app (Electron-ABI), и vitest (Node-ABI) — а бинарник в репозитории один.** Отсюда две взаимоисключающие потребности:

| Что запускаем | Нужен ABI | Чем переключить |
|---|---|---|
| Тесты (`pnpm -r test`) | **Node** (137) | `prebuild-install --runtime node --target 24.19.0` |
| CDP-смоук (живой клиент) | **Electron** (148) | `corepack pnpm -C electron-app exec electron-builder install-app-deps` |

**Симптом неверного ABI (важен):** клиент **не создаёт окно**. CDP отвечает (`/json/version` живой), но `/json/list` пуст — вкладок нет, смоук падает с «нет ни одной вкладки Electron в CDP». В логе клиента — `better_sqlite3.node was compiled against a different Node.js version ... NODE_MODULE_VERSION 137 ... requires 148`, дальше `sqlite init failed` → `DB self-heal failed` → `emergency update mode` → окно не открыто. **Не ищи тут ошибку в своём коде — это ABI.**

**Лечение Node-ABI (для тестов), после остановки клиента** — файл держит запущенный `electron.exe`, без его остановки prebuild-install падает с `EBUSY`:
```powershell
& .\.claude\skills\verifier-electron\scripts\stop.ps1   # electron.exe держит .node
cd node_modules\.pnpm\better-sqlite3-multiple-ciphers@12.11.1\node_modules\better-sqlite3-multiple-ciphers
node ..\..\..\prebuild-install@7.1.3\node_modules\prebuild-install\bin.js --runtime node --target 24.19.0
```
Размер бинарника говорит, что стоит: **Node-ABI = 2 280 960 байт**, **Electron-ABI = 2 281 472 байт**. Готовые сборки лежат в `.verifier-electron/abi-backup/` (Node) и `.verifier-electron/abi-electron-*` (Electron).

**Самый быстрый переключатель ABI — копия готовых бинарей (выучено 2026-11-13, смоук `cdp-rail-defaults-tab-star.mjs`).** Никакой пересборки: `prebuild-install`/`install-app-deps` занимают минуты, а копия — секунды. Готовые файлы: Node — `.verifier-electron\abi-backup\better_sqlite3.mc.node` (2 280 960) и `better_sqlite3.node` (1 919 488); Electron — `.verifier-electron\abi-electron-20261022\better_sqlite3.mc.node` (2 281 472) и `better_sqlite3.node` (1 920 512). Копируются в:
```powershell
# → Electron-ABI (перед смоуком)
Copy-Item 'D:\valstan\REPO\MatricaRMZ\.verifier-electron\abi-electron-20261022\better_sqlite3.mc.node' 'D:\valstan\REPO\MatricaRMZ\node_modules\.pnpm\better-sqlite3-multiple-ciphers@12.11.1\node_modules\better-sqlite3-multiple-ciphers\build\Release\better_sqlite3.node' -Force
Copy-Item 'D:\valstan\REPO\MatricaRMZ\.verifier-electron\abi-electron-20261022\better_sqlite3.node' 'D:\valstan\REPO\MatricaRMZ\node_modules\.pnpm\better-sqlite3@12.11.1\node_modules\better-sqlite3\build\Release\better_sqlite3.node' -Force
# → Node-ABI (перед тестами) — те же файлы из .verifier-electron\abi-backup\
```
**Переключать нужно ОБА пакета** (см. предупреждение ниже). Копировать с `cd` в той же команде safety-политика блокирует — указывать абсолютные пути.

**Лок на `.node` держит не только клиент, но и backend стенда (26.11.2026, полоса 6).** После `stop.ps1` (клиент погашен) копирование Node-ABI всё равно падало: «Процесс не может получить доступ к файлу … так как этот файл используется другим процессом», а `rm` в корзину — «The system call level is not correct». Держал **backend** (`tsx src/index.ts`): он открывает `better_sqlite3.node` при старте ⇒ **порядок: сначала гасить backend, потом копировать ABI** (иначе стенд вернёт Electron-ABI, а тесты упадут на `NODE_MODULE_VERSION`). Кто держит файл — видно так: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*worktrees\\<имя>*' }`.

**`pnpm rebuild better-sqlite3-multiple-ciphers` НЕ помогает** — он ничего не пересобирает (тихий no-op). `pnpm rebuild better-sqlite3` пересобирает только «обычный» пакет, а тесты и клиент берут **multiple-ciphers**. Рабочая команда — `prebuild-install` выше.

**⚠️ Нативных пакетов ДВА, и переключать нужно оба (выучено 2026-11-11).** Клиент (Electron-ABI) берёт `better-sqlite3-multiple-ciphers`, а тесты `android-app` берут **обычный** `better-sqlite3` — это разные пакеты в `.pnpm` с разными бинарями. Переключил только multiple-ciphers → `pnpm -r test` упал на `android-app` (13 файлов / 57 тестов) с `NODE_MODULE_VERSION 148 ... requires 137`; `android-app` при этом зелёный был в одиночку до переключения. Лечится той же командой `prebuild-install` из каталога второго пакета:
```powershell
cd node_modules\.pnpm\better-sqlite3@12.11.1\node_modules\better-sqlite3
node ..\..\..\prebuild-install@7.1.3\node_modules\prebuild-install\bin.js --runtime node --target 24.19.0
```
Размеры бинаря обычного `better-sqlite3`: **Node-ABI = 1 919 488 байт**, **Electron-ABI = 1 920 512 байт**. Проверка одной строкой — `node -e "new (require('./lib/database.js'))(':memory:')"` из каталога пакета: если модуль под Node, ошибки ABI не будет.

**Порядок проверки после переключения ABI:** гонять `pnpm -r test` пакетами по одному (`-F @matricarmz/android-app test` и т. д.), а не только общий прогон: `-r test` останавливается на первом красном пакете, и «красный android-app» означает, что `backend-api` и `electron-app` вообще не запускались.

**⚠️ `electron-builder install-app-deps` переключает ABI МОЛЧА НЕПРАВИЛЬНО (выучено 2026-11-11).** Команда печатает «finished moduleName=better-sqlite3-multiple-ciphers» и **не трогает бинарник**: `node-abi@3.85.0` в репозитории **не знает Electron 43** («Could not detect abi for version 43.0.0 and runtime electron»), @electron/rebuild тихо пропускает шаг, и файл остаётся с прошлой сборки. Симптом: клиент не открывает окно (CDP живой, вкладок нет), а размер бинаря не сходится с ожидаемым для Electron-ABI. Готовых пребилдов под ABI Electron 43 (148) нет ни в одной версии multiple-ciphers (максимум electron-v146), поэтому нужен компилятор (VS Build Tools 2022 стоят). Рабочая команда — `node-gyp` напрямую из каталога пакета:
```powershell
cd node_modules\.pnpm\better-sqlite3-multiple-ciphers@12.11.1\node_modules\better-sqlite3-multiple-ciphers
node ..\..\..\node-gyp@12.4.0\node_modules\node-gyp\bin\node-gyp.js rebuild `
  --runtime=electron --target=43.0.0 --dist-url=https://electronjs.org/headers --arch=x64 --msvs_version=2022
```
**⚠️ Путь к node-gyp — ТРИ уровня вверх, а не четыре (исправлено 12.11.2026).** Из каталога пакета
`...\.pnpm\better-sqlite3-multiple-ciphers@12.11.1\node_modules\better-sqlite3-multiple-ciphers`
три `..` дают `.pnpm`, где и лежит `node-gyp@12.4.0`; четыре `..` уводят в `node_modules` — там
node-gyp нет, и команда падает с «Cannot find module ... node-gyp.js». Надёжнее — абсолютный путь:
```powershell
node D:\valstan\REPO\MatricaRMZ\node_modules\.pnpm\node-gyp@12.4.0\node_modules\node-gyp\bin\node-gyp.js rebuild `
  --runtime=electron --target=43.0.0 --dist-url=https://electronjs.org/headers --arch=x64 --msvs_version=2022
```
Проверено 12.11.2026: сборка проходит (`gyp info ok`), бинарь становится **2 281 472** (Electron-ABI),
обратно на Node-ABI — `prebuild-install --runtime node --target 24.19.0` обоим пакетам (2 280 960 и 1 919 488).
Признак, что переключились: размер бинаря стал **2 281 472** (Electron-ABI) и `node -e "require('<путь>/better_sqlite3.node')"` **падает** с «NODE_MODULE_VERSION 148 ... requires 137» — под Node он грузиться не должен. Обратно на Node-ABI — `prebuild-install --runtime node --target 24.19.0` (обоим пакетам, см. выше).

### ⚠️ Правка файлов из PowerShell: `-Encoding utf8` пишет BOM (выучено 2026-10-06)

Правил `App.tsx` через `Get-Content -Raw | -replace ... | Set-Content -Encoding utf8` — и получил **две** поломки сразу:

1. **`-Encoding utf8` в Windows PowerShell пишет UTF-8 С BOM.** Файл без BOM получил BOM: в `git diff` это первая строка `+import React…` вместо `-﻿import React…`, то есть правка одной строки выглядит правкой четырёх. Часть файлов в репозитории BOM имеет намеренно (`App.tsx`) — снятие BOM там тоже лишняя строка в диффе, которая не имеет отношения к задаче.
2. **Кириллица в выводе консоли — кракозябры** (`Get-Content`/`Select-String` без `-Encoding utf8` показывают «Этапы ремонта» как `?⠯? ६???`). Проверять результат такой правки глазами через PowerShell нельзя: правка может быть верной, а покажется мусором.

Рабочий путь на этой машине — **правка через node-скрипт** (`fs.readFileSync` / `fs.replace` / `fs.writeFileSync`) с проверками: «строка встречается ровно 1 раз», «после правки нет ``», «BOM был — вернуть». Многострочные шаблоны собирать построчно (`split(/\r?\n/)`): файлы в репозитории CRLF, и шаблон с `\n` просто не находится. Проверка результата — `git diff`, а не вывод команды.

## WSL2 — сессии opencode (2026-10-15)

> ⚠️ **18.10.2026: WSL-дистрибутива на машине нет** (`wsl -l -v` → «нет установленных дистрибутивов»). Раздел оставлен как запись о том, как это было устроено. Заодно снят repo-local `credential.https://github.com.helper` с WSL-путём `/mnt/c/…gh.exe` (на Windows он только сорил ошибками) — аутентификация идёт системным `manager` (GCM).

Прежняя запись «ни WSL» устарела: WSL2 поднят (ядро `6.18.54.1-microsoft-standard-WSL2`), репо видно как `/mnt/d/valstan/REPO/MatricaRMZ` (brain — `/mnt/d/valstan/REPO/brain_matrica`). Используется для сессий opencode; Windows-тулчейн (PowerShell/стенд/CDP-смоук) этим не заменяется.

- **Node в WSL** — v24.22.0 (в Windows — 24.19.0); `corepack pnpm` 10.26.1 работает; `python3` здесь настоящий (Store-заглушка — про Windows).
- **CRLF-настройка обязательна один раз:** без неё `git status` показывает ~2000 файлов изменёнными (CRLF-рабочая копия против LF-индекса; `git diff --ignore-cr-at-eol` при этом пуст). Лечится repo-local: `git config core.autocrlf true` → статус чист.
- **push из WSL:** у WSL-гита нет кредов GitHub (fetch публичного репо идёт анонимно, push падает `could not read Username`). Repo-local helper через Windows gh.exe:
  `git config credential.https://github.com.helper '!"/mnt/c/Program Files/GitHub CLI/gh.exe" auth git-credential'`
  Проверка: `printf 'protocol=https\nhost=github.com\n\n' | git credential fill` → username `Valstan`.
- **gh CLI** — только `gh.exe` (`/mnt/c/Program Files/GitHub CLI/gh.exe`); Linux-gh не установлен. `--body-file` принимать в Windows-пути: `--body-file "$(wslpath -w /tmp/opencode/pr-body.md)"`.
- **vitest в WSL не гоняется** (`node_modules` собран под Windows: native-модули rollup/esbuild — win32, на Linux `MODULE_NOT_FOUND`). Гейт-тесты здесь гоняет CI.
- **Локальные гейты, которые всё же идут:**
  - typecheck: `node node_modules/typescript/lib/tsc.js -p backend-api/tsconfig.json --noEmit` (tsc — чистый JS; `shared/dist` и `ledger/dist` должны быть собраны Windows-сессией);
  - eslint: `node node_modules/eslint/bin/eslint.js <файлы> --max-warnings 0` из корня (бинарник hoisted в корневой `node_modules`).


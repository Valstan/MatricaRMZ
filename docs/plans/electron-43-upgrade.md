# План: апгрейд Electron 41 → 43

**Статус:** ФАЗЫ A+B ЗЕЛЁНЫЕ — PR #89 готов к мержу (ждёт OK владельца); дальше релиз. 2026-07-05
**Ветка:** `chore/electron-43-upgrade`
**Триггер:** PENDING «Электрон 42/43 — РАЗБЛОКИРОВАНО» (#87). Целимся сразу в **E43** (43.0.0, latest), с дешёвым CI-пробником; откат на E42 (42.6.0) если форк не соберётся.

## Context / что уже выяснено (2026-07-05)

- Клиентский рантайм-натив — **`better-sqlite3-multiple-ciphers`** (`electron-app/src/main/database/db.ts:5`), plain `better-sqlite3` только в тестах/типах.
- `electron-app/package.json` → `build.buildDependenciesFromSource: true` → electron-builder собирает натив **из исходников** под целевой Electron-ABI при паковке. Значит CI-сборка реально проверит компиляцию форка под V8 E43.
- `node-abi@4.31.0` (в `@electron/rebuild@4.0.4`, его же тянет `electron-builder@26.8.1`) знает **E42→ABI146**, **E43→ABI148**. Тулчейн пересборки готов к обоим.
- ⚠️ Форк `better-sqlite3-multiple-ciphers` на npm **максимум `12.11.1`**; обещанной в #87 версии `12.11.2` (пребилды E43) на реестре нет (и upstream `better-sqlite3` тоже 12.11.1). Фикс `External::New` для E42 — в upstream `12.10.1` ≤ 12.11.1 → **E42 форк собирает уверенно**. Соберётся ли **из исходников под E43** — ровно это и проверяет CI-проба.
- CI-workflow `release-electron-windows.yml`: `electron-builder --win --x64` с дефолтным `npmRebuild` → пересборка натива автоматом. Менять workflow, вероятно, не нужно. `workflow_dispatch` собирает инсталлер БЕЗ публикации + артефакт `matricarmz-installer-test`.
- Последние версии: Electron **42.6.0** (42-x-y), **43.0.0** (latest).

## Фазы

### Фаза A — CI-проба E43 (ГЕЙТ)
1. ✅ Ветка `chore/electron-43-upgrade`, бамп `electron` `^41.7.1` → `^43.0.0`, `pnpm install`.
2. ✅ Локальные гейты под E43: **typecheck чист** (ни один used API не удалён/изменён), **lint чист**, **`electron-vite build` чист** → JS/TS-сторона полностью E43-совместима.
3. ✅ Проба #1 (run 28750895375) — **упала** на `electron-builder`, но НЕ на форке: на **plain `better-sqlite3@12.10.0`** (V8 `External::New`/`External::Value`/`SetNativeDataProperty`). Plain — runtime-dep (`drizzle-orm/better-sqlite3/driver.cjs:35` top-level `require`), был застрял на 12.10.0 (до фикса 12.10.1). Транзитивный 12.10.0 у backend-api electron-builder НЕ трогает.
4. ✅ Фикс: бамп plain `better-sqlite3` `^12.10.0` → `12.11.1` (вровень с форком).
5. ✅ Проба #2 (run 28751100844) — **ЗЕЛЁНАЯ**. `electron-builder` собрал инсталлер (135MB): **оба** `better-sqlite3@12.11.1` (plain) и `better-sqlite3-multiple-ciphers@12.11.1` (форк) компилируются из исходников под **V8 E43 (ABI 148)**. Опасение из #87 («форку нужна 12.11.2 для E43») — **неверно**: 12.11.1 тянет E43. Целимся в E43, откат на E42 не нужен.

### Фаза B — верификация (ЗЕЛЁНАЯ)
4. ✅ Дедуп натива: backend-api `better-sqlite3` `^12.10.0`→`^12.11.1` (E43-бамп electron-app развёл стор на 12.10.0/12.11.1; локальный `@electron/rebuild` сканит весь стор и спотыкался о pre-fix 12.10.0). Теперь монорепо на едином `better-sqlite3@12.11.1`.
5. ✅ Локальная пересборка натива под E43: `@electron/rebuild --force --version 43.0.0 --only better-sqlite3-multiple-ciphers,better-sqlite3` → `✔ Rebuild Complete` (ABI 148). NB: сработало только после дедупа + после отдельной **до-качки бинаря Electron 43** (postinstall при `pnpm install` молча упал по флаки-сети → `node .../electron/install.js`).
6. ✅ **Локальный boot-смоук** (dev-стек, CDP=9222, изолированный userData — установленного прод-клиента не трогает): `IPC registered, SQLite ready` (шифрованная натив-БД открылась под ABI 148, БЕЗ `NODE_MODULE_VERSION`/`self-heal`/`emergency`); CDP DOM — полный UI под юзером `verify` (сессия восстановлена из шифрованного кэша, меню рендерится под Chromium E43). `ERR_CONNECTION_REFUSED` — только backend не поднят, ожидаемо.
7. ⏭️ On-machine install CI-артефакта — **НЕ делали**: на rmz4val уже стоит реальный релиз-клиент v2026.704.951 (не создан этой сессией) + CDP в прод-сборке отключён (index.ts:56) → install поверх рискован и слеп. Локальный dev-смоук перекрывает риск.

### Дальше — релиз (отдельный осознанный шаг владельца, `/reliz`)
- CalVer bump, `releaseWelcome.ts` + новый эпиграф, тег `v*`, прод-своп артефактов. Релиз попутно несёт накопленные #76–#88.
- Прод-деплой: backend-пакеты пересобрать (`better-sqlite3` бампнут → `pnpm install` на проде подтянет 12.11.1 под Node-ABI). Клиент едет готовым CI-инсталлером.

## Риски / грабли
- Форк 12.11.1 может не собраться под E43 (нет «12.11.2») → Фаза A это ловит; откат на E42.
- Локальная пересборка натива под E43 может упасть (тулчейн rmz4val, GOTCHAS M2) → тогда верификация через CI-артефакт + on-machine install (не требует локального компилятора).
- E41→E43 — перескок мажора: проверить breaking changes Electron API, используемых в `main`-процессе (app/BrowserWindow/session/protocol).

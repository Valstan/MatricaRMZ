# План: апгрейд Electron 41 → 43

**Статус:** ФАЗА A (CI-проба E43) — в работе с 2026-07-05
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
1. ✅ Ветка `chore/electron-43-upgrade`, бамп `electron` `^41.7.1` → `^43.0.0`, `pnpm install` (electron 43.0.0 встал, lockfile обновлён).
2. ⏳ Commit + push + `gh workflow run "Release Electron (Windows)" --ref chore/electron-43-upgrade`.
3. ⏳ Дождаться прогона. **Зелёный** (инсталлер собрался = форк скомпилировался под ABI 148) → Фаза B на E43. **Красный** на пересборке `multiple-ciphers` → откат на E42 (42.6.0), повтор пробы.

### Фаза B — верификация + релиз (если A зелёная)
4. On-machine install-тест артефакта `matricarmz-installer-test` (петля watchdog из `docs/machines/rmz4val.md`): тихий install → клиент грузится без sqlite/ABI-ошибки в `matricarmz.log`.
5. Локальный dev-стек: пересобрать `multiple-ciphers` под E43-ABI (`@electron/rebuild --force --version 43.0.0`), CDP-смоук что клиент бутится и логинится.
6. Стандартные гейты: typecheck + lint + backend-тесты (клиентская правка, но гейты прогоняем).
7. Релизная нитка (`/reliz`, отдельный осознанный шаг владельца): CalVer bump, `releaseWelcome.ts` + новый эпиграф, PR, merge, тег `v*`, прод-своп артефактов. Релиз попутно несёт накопленные #76–#88.

## Риски / грабли
- Форк 12.11.1 может не собраться под E43 (нет «12.11.2») → Фаза A это ловит; откат на E42.
- Локальная пересборка натива под E43 может упасть (тулчейн rmz4val, GOTCHAS M2) → тогда верификация через CI-артефакт + on-machine install (не требует локального компилятора).
- E41→E43 — перескок мажора: проверить breaking changes Electron API, используемых в `main`-процессе (app/BrowserWindow/session/protocol).

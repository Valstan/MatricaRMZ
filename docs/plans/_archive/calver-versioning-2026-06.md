# CalVer auto-version — убрать ручное ведение версий

> Утверждён владельцем 2026-06-14. Core реализован в ветке `feat/calver-auto-version` (генератор + shared-хелпер + доки); UI-display даты в окне обновления — отдельно, с директивой brain `update-module-revamp`.

## Context

Владелец (2026-06-14): «это просто программа» — ручной выбор semver (patch/minor/major) на каждый релиз не нужен. Есть прод с обновляемыми модулями и Windows-клиент, которому надо лишь понимать «вышло новое». Полностью без версии нельзя: `electron-updater` сравнивает версию в `latest.yml` с установленной — это единственный механизм детекта обновления. Значит версия остаётся **технической меткой**, но генерируется **автоматически** (никто не придумывает число).

## Решение: Option A — CalVer, генерируемый скриптом, по-прежнему коммитится

Заменяем «человек выбирает число» на «скрипт штампит дату». Версия остаётся в `VERSION` + 4 `package.json` (как сейчас) → весь downstream-конвейер (electron-builder → `latest.yml`, тег `v*`, CI, `/health`, ledger-publish, welcome) **работает без изменений**, потому что CalVer — валидный монотонный semver.

**Формат CalVer:** `YYYY.(MM*100+DD).(HH*100+MM)` — напр. сборка 14 июня 2026 15:30 → **`2026.614.1530`**.
- Все три сегмента — целые **без ведущих нулей** (semver их запрещает): `MM*100+DD` ≥ 101, `HH*100+MM` ≥ 0. НЕ `2026.0614.1530`.
- Монотонно: `major`=год → месяц-день → час-минута. Любой CalVer > старого `1.x` (год 2026 > 1) → welcome/детект обновления переключаются гладко. Время-компонент исключает коллизию двух релизов в день.

**Почему не Option B (CI-генерация без коммита):** backend на проде собирается из исходников → его версия = коммитнутый `package.json`; без коммита backend (`/health`) и клиент разъедутся. Коммит версии держит их синхронными и не трогает welcome-keying.

## Изменения

**Core (ветка `feat/calver-auto-version`):**
1. `scripts/bump-version.mjs` → CalVer-генератор: по умолчанию штампит текущую дату; `--date <iso>` для детерминизма; `--set X.Y.Z` — аварийный оверрайд (с проверкой semver/без ведущих нулей). Убраны `--major/--minor`.
2. `shared/src/domain/calver.ts` (новый, экспортирован из index) — `calverFromDate`, `parseCalver`, `formatCalverBuildDate` (CalVer→«ДД.ММ.ГГГГ ЧЧ:ММ», `null` для не-CalVer) + юнит-тест `calver.test.ts`.
3. `CLAUDE.md` §Release process + `.claude/commands/reliz.md` — убран ручной выбор версии; поток: `bump-version` (без аргумента) → welcome (`releaseLabel`=CalVer) → PR → тег `v<calver>`.
4. `docs/PENDING_FOLLOWUPS.md` — исправлен пример формата (без ведущего нуля).

**Совместимость (проверить, не править):** `scripts/publish-ledger-release.mjs` валидатор `^\d+\.\d+\.\d+$` и CI-триггер `v*.*.*` — тег `v2026.614.1530` матчит. ✅

**Отложено (с директивой brain `update-module-revamp`):** human-facing **display даты сборки** вместо сырого CalVer — в окне «Что нового» (App.tsx, `releaseLabel`/`currentVersion`) и в окне обновления; `/health` `buildDate` (можно выводить через `formatCalverBuildDate(version)` без отдельного env). Хелпер уже готов в `shared`. Верифицируется end-to-end на первом CalVer-релизе.

## Не трогаем
- sync/ledger protocol version (`sync_protocol_version` — не релизная версия).
- `electron-builder` config (версию берёт из `package.json`).
- welcome shouldShow-логику (electron main) — сравнение версий монотонно на CalVer.

## Verification
- **Юнит:** `corepack pnpm -F @matricarmz/shared test` (calver round-trip, no-leading-zero, монотонность, `1.x`→null).
- **Генератор:** `node scripts/bump-version.mjs --date 2026-06-14T15:30` → VERSION/4×package.json = `2026.614.1530`; `--set` валидирует.
- **Сборка:** `corepack pnpm -r typecheck` + `lint`; `pnpm -C shared build`.
- **Первый реальный релиз** — обычным `/reliz`: на проде `/health` (CalVer) и `/updates/status` (`latest.version` = CalVer) + клиент видит обновление.

## Rollout
Первый CalVer-релиз заодно отгрузит накопленное на `main` (фикс вёрстки списка деталей #368). Откат тривиален: `bump-version.mjs --set` вручную (формат semver не меняется, downstream совместим).

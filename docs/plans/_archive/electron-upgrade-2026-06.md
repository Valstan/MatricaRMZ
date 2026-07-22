# План: апгрейд Electron 33 → 41 (security-долг, ADR-0001 Этап 3)

**Статус:** реализация завершена локально, готов PR (ветка `chore/electron-42-upgrade`, 2026-06-05). Релиз (bump+tag+deploy) — отдельным шагом по решению владельца.

> **Цель скорректирована 42 → 41 в ходе работы:** `better-sqlite3` 12.10.0 (latest) **не компилируется под Electron 42** — Chromium 148 / V8 сделал 3-й параметр `tag` у `v8::External::New` обязательным (`error C2660`, `better_sqlite3.cpp:60` зовёт 2-арг форму), а maintainers ещё не адаптировали. Под **Electron 41.7.1** (Chromium 146) собирается чисто. 41 — самый высокий в поддерживаемом окне (40/41/42), который собирает latest better-sqlite3 → вышли из EOL в supported window без патча вендорного модуля. **Follow-up:** вернуться к 42, когда better-sqlite3 адаптирует `External::New` под tag-сигнатуру.

## Context

`electron@^33.2.1` (≈окт 2024) — **≈9 мажоров позади**, давно EOL (Electron 39 EOL 2026-05-05). Это накопленный **security-долг** (Chromium CVE), не гонка за фичами. ADR-0001 ([`docs/adr/0001-client-install-update-architecture.md`](../../adr/0001-client-install-update-architecture.md)) Блок 4 + Этап 3 зафиксировали направление: поднять Electron в поддерживаемое окно, `electron-builder → 26.x`, **обязательный rebuild `better-sqlite3`** под новый ABI, smoke-тест клиента, **отдельным релизом** (не смешивать с delta-обновлениями Этапа 2).

Цель — выйти из EOL с максимальным запасом по сроку поддержки, не сломав: загрузку нативной SQLite в клиенте, IPC, печать отчётов и кастомный апдейтер.

### Зафиксированные факты (разведка 2026-06-05)
- **Поддерживаемое окно (июнь 2026):** Electron **40 / 41 / 42**; последний stable — **v42.3.3**; Electron 43 — alpha/beta. Релиз раз в 8 недель. → **цель: Electron 42** (дольше всех в окне поддержки).
- **Electron 42 = Chromium 148 / Node 24** (V8-ABI клиента меняется → нативный модуль обязателен к пересборке).
- **`better-sqlite3`:** сейчас `^11.7.2` → резолв **11.10.0**; **один общий pnpm-инстанс** на `electron-app` и `backend-api`. Актуальная — **12.10.0**. Для Electron 39+ официальные prebuilds нестабильны → опора на сборку из исходников (Windows-toolchain на CI-раннере `windows-2022` есть).
- **backend-api** использует `better-sqlite3` только в `backend-api/src/scripts/nightlyBackup.ts` (in-memory snapshot); прод — PostgreSQL. → бамп в lockstep безопасен.
- **CI сборка:** [`.github/workflows/release-electron-windows.yml`](../../.github/workflows/release-electron-windows.yml) — Node 22, pnpm 10.26.1, `electron-vite build` → `electron-builder --win --x64 --publish always`. electron-builder при упаковке вызывает `@electron/rebuild` (уже в lock как `3.6.1`) под ABI целевого Electron — packaged-путь надёжнее dev.
- **M0 РЕЗУЛЬТАТ:** `.npmrc` (root) содержит **только** `only-built-dependencies[]` — **нет** `runtime`/`target`/`disturl`; `electron-app/.npmrc` отсутствует. Значит `pnpm install` собирает `better-sqlite3` под **хостовый Node**, не Electron → Electron-ABI rebuild **должен** делаться явно: **`corepack pnpm -C electron-app exec electron-builder install-app-deps`** (каноничный шаг, новых deps не нужно). `externalizeDepsPlugin()` в [`electron-app/electron.vite.config.ts`](../../electron-app/electron.vite.config.ts) оставляет модуль внешним (грузится из node_modules в рантайме).
- **Main-процесс API:** только стабильные модули (`app`, `BrowserWindow`, `Menu`, `net`, `safeStorage`, `ipcMain`, `dialog`, `shell`, `nativeImage`, `session`) → риск API-миграции **умеренный**.

## Целевые версии (решение принято — owner делегирует технические выборы)
| Пакет | Было | Станет | Где |
|---|---|---|---|
| `electron` | `^33.2.1` | `^41.7.1` | `electron-app` devDep |
| `electron-builder` | `^25.1.8` | `^26.8.1` | `electron-app` devDep |
| `better-sqlite3` | `^11.7.2` | `^12.10.0` | **`electron-app` И `backend-api`** (lockstep) |
| `@types/better-sqlite3` | `^7.6.12` | `^7.6.13` | `electron-app` devDep |
| `electron-vite` | `^2.3.0` | оставлен `^2.3.0` (не понадобилось) | `electron-app` devDep |

Доп. правки конфига `electron-app/package.json` `build`:
- **`win.signingHashAlgorithms` → `win.signtoolOptions.signingHashAlgorithms`** — electron-builder 26 убрал опцию из корня `win` (схема-валидация падала).
- **`buildDependenciesFromSource: true`** (новый) — **критично для корректности релиза.** `@electron/rebuild` с `buildFromSource=false` (дефолт `install-app-deps`/packaging) для better-sqlite3 ненадёжен: может оставить/утянуть **Node-prebuild (137)** вместо сборки под Electron (145) → installer уедет с битым нативным модулем (клиент падает на SQLite-init → «emergency update mode»). Флаг форсит node-gyp source build под ABI Electron. Подтверждено: с флагом `install-app-deps` логирует `buildFromSource=true` → ABI 145. (toolchain MSVS на windows-2022 есть.)

Node на CI — оставлен **22** (electron-builder пересобирает под ABI Electron независимо от хост-Node; source-build better-sqlite3 12.x под Node 22 на windows-2022 работает).

### Грабли better-sqlite3 (общий pnpm-инстанс, две ABI)
`better-sqlite3` — **один `.node` на `electron-app` + `backend-api`**, не может обслужить Electron-ABI (145) и Node-ABI (137) одновременно. **После любого `pnpm install`/`pnpm rebuild` → Node-ABI** (нужно vitest); перед Electron-стеком (dev/verifier/packaging) → `install-app-deps` (Electron-ABI). SKILL.md verifier'а обновлён этой заметкой.

## Этапы (ветка `chore/electron-42-upgrade`, релиз — отдельной версией)

- **M0 ✅** — механизм rebuild зафиксирован (см. выше).
- **M1 ✅** — бамп версий (electron 41.7.1, builder 26.8.1, bsq 12.10.0, @types 7.6.13) в обоих `package.json`; `pnpm install` + `install-app-deps`. Попутно: Electron 42 отвергнут (External::New), переключён на 41.
- **M2 ✅** — ABI-смоук: бинарником Electron 41 загружен better-sqlite3, query OK (`electron 41.7.1`, `NODE_MODULE_VERSION 145`).
- **M3 ✅** — `typecheck` зелёный (0 поломок на d.ts Electron 41 — код не правился), `build` зелёный, **vitest 98/98** (под Node-ABI). `lint` — 3 pre-existing ошибки (`react-hooks/exhaustive-deps` rule-not-found + unused vars) НЕ связаны с апгрейдом (CI lint не гоняет). API-миграция правок не потребовала.
- **M4 ✅** — найден+исправлен schema-break `win.signtoolOptions`; добавлен `buildDependenciesFromSource: true`; `installer.nsh` совместим (стандартные хуки); squirrel-windows 25.1.8 peer-warning — benign (optional peer для неиспользуемого squirrel.windows-таргета; pnpm не схлопывает sticky optional, override не помог — оставлен warning).
- **M5 ⚠️** — конфиг builder 26 валиден, native-rebuild под Electron 41 подтверждён (`buildFromSource=true` → 145). Запуск packaged-exe **локально заблокирован** привилегией Windows на симлинки при распаковке winCodeSign (Dev Mode off) — **CI-нерелевантно** (windows-2022 имеет привилегию). Runtime перекрыт M6.
- **M6 ✅** — клиент Electron 41 поднят через verifier: CDP renderer-таргет «Матрица РМЗ» загружен, лог `sqlite migrationsFolder` → `IPC registered, SQLite ready` (без NODE_MODULE_VERSION). SKILL.md обновлён (install-app-deps + ABI-dance заметка).
- **M7** — релиз отдельной версией (CLAUDE.md §Release): bump-version, `RELEASE_WELCOME_HISTORY` ([`releaseWelcome.ts`](../../shared/src/domain/releaseWelcome.ts)), PR → OK → merge → tag → CI. Миграций БД нет. Watch диагностику/`/updates/status` 24-48ч. PC36 (1.27.0) — отдельно.

## Verification (итог)
1. ✅ `typecheck`/`build`/`test` (98/98) зелёные на Electron 41; `lint` — pre-existing ошибки вне scope.
2. ✅ dev/runtime (M6): SQLite открывается + миграции + IPC ready, рендерер грузится — без NODE_MODULE_VERSION.
3. ⚠️ packaged `--dir`: конфиг+native-rebuild подтверждены; exe-launch локально заблокирован winCodeSign-симлинками (CI-only path).
4. ✅ /verify (CDP): boot + renderer + SQLite ready.
5. ⬜ CI: тег → installer (с `buildDependenciesFromSource` better-sqlite3 12.x из исходников под Electron 41 на windows-2022) — проверить при релизе.
6. ⬜ Прод (при релизе): `/health` + `/updates/status` = новая версия; мониторинг 24-48ч.

## Чего НЕ делаем
- Delta-обновления (Этап 2 ADR-0001) — отдельный релиз.
- React 18→19 (ортогонально, вне scope).
- Turborepo (Этап 4).
- Runtime-дробление клиента (ADR-0001 Блок 6).

## Локальные env-затыки (НЕ на CI — для следующей сессии)
- **electron-builder packaging локально:** (1) corepack/глобальный pnpm 11 vs пин 10.26.1 в node-module-collector → запускать без `corepack` (`pnpm exec electron-builder`, само-переключается); (2) winCodeSign распаковка падает на macOS-симлинках без Dev Mode/admin → packaged-сборку гонять на CI (windows-2022), не локально на PC40.

## Риски (статус)
- ✅ better-sqlite3 12.x под Electron 41 — собирается из исходников (закрыто `buildDependenciesFromSource`).
- ✅ electron-builder 26 конфиг — `signtoolOptions` исправлен; squirrel-warning benign.
- ✅ `net`-модуль 33→41 — typecheck+runtime чисты, правок не потребовалось.
- ✅ API-поверхность main — typecheck без ошибок.

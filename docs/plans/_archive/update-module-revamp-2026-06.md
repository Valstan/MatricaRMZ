# update-module-revamp — окно обновления: честный прогресс + степпер + дата сборки + декор


## Context

Директива brain `update-module-revamp` (2026-06-13, SHOULD). Текущее окно обновления (`electron-app/src/renderer/public/update.html`) — спартанское: заголовок, строка-сообщение, «N%», «Новая версия: V», один прогресс-бар, лог. Оператор не видит честной картины: сколько МБ из скольких, скорость, сколько осталось, на каком этапе процесс, что за версия (и тем более — после перехода на CalVer лейбл станет сырым `2026.614.1530`). Надо: честный прогресс (МБ/скорость/ETA), степпер этапов, версия как **дата сборки** (CalVer), внятная ошибка (вкл. G42 emergency-update), лёгкий тематический декор (летающие запчасти), `prefers-reduced-motion`. Верификация — **симуляцией событий апдейтера** (без реального релиза).

## Архитектура (как есть)

- Окно — отдельный `BrowserWindow` (`updateUiWindow` в [updateService.ts](../electron-app/src/main/services/updateService.ts):727 `showUpdateWindow`), грузит статический `dist/renderer/update.html` (источник `src/renderer/public/update.html`), CSP `'self'` + inline style/script.
- Состояние пушится из main: `pushUpdateUiState()` → IPC `update:state` → preload [src/preload/update.ts](../electron-app/src/preload/update.ts) `window.matricaUpdate.onState(state)` (форвардит payload **verbatim**) → HTML рендерит.
- Текущая форма `UpdateUiViewState = { message, pct, version, logs[] }`.
- Прогресс приходит как **кастомный** `onProgress(pct, transferred, total)` (несколько источников: github/yandex/lan — updateService.ts ~1728/1772/1938), **не** нативный electron-updater `download-progress` → **скорость/ETA считаем сами** из дельт `transferred`+времени. Формат «X.X / Y.Y MB» уже собирается в этих сайтах (заменим централизованным хелпером).
- `formatCalverBuildDate(version)` уже есть в `@matricarmz/shared` (CalVer→«ДД.ММ.ГГГГ ЧЧ:ММ», `null` для не-CalVer) — main импортирует shared, используем для лейблов.

## Дизайн

**1. Обогатить `UpdateUiViewState`** (updateService.ts) + зеркально тип в preload (TS-only, рантайм форвардит любые поля):
```
stage: 'checking'|'downloading'|'verifying'|'installing'|'restarting'|'uptodate'|'error'
transferredBytes, totalBytes: number|null
bytesPerSecond: number|null      // вычислено в main
etaSeconds: number|null          // (total-transferred)/bps
versionFromLabel, versionToLabel: string   // formatCalverBuildDate(v) ?? raw, готовые в main
errorText: string|null
+ существующие message, pct, version, logs
```

**2. Хелперы в updateService** (single source, без дублирования по источникам):
- `setUpdateStage(stage)` — ставит `stage` + дефолтное `message`, `pushUpdateUiState()`. Врезать в точках потока: `showUpdateWindow`→`checking`; старт загрузки→`downloading`; sha256-проверка (`sha256` ~356)→`verifying`; spawn installer→`installing`; `quitMainAppSoon`→`restarting`; not-available→`uptodate`; catch→`error` (+`errorText`).
- `setDownloadProgress(pct, transferred, total)` — единая замена inline-формул в 3 onProgress-сайтах: пишет transferred/total, считает `bytesPerSecond` (сглаженная Δtransferred/Δt, хранит lastTransferred/lastTs в модуль-скоупе) и `etaSeconds`, обновляет `message`, `pushUpdateUiState()`.
- Лейблы версий: `versionFromLabel`=`formatCalverBuildDate(app.getVersion()) ?? app.getVersion()`, `versionToLabel` аналогично для версии обновления — ставить при обнаружении версии.

**3. Переписать `update.html`** (статический, без фреймворков, CSP не трогаем — inline хватает):
- **Степпер** 5 этапов (Проверка → Скачивание → Целостность → Установка → Перезапуск): текущий подсвечен, пройденные ✓, будущие приглушены; маппинг из `state.stage`.
- **Прогресс**: бар + строка «X.X / Y.Y МБ · N.N МБ/с · осталось ~Mм Сс» (из transferred/total/bps/eta; при неизвестном total — без знаменателя/ETA). `font-variant-numeric: tabular-nums`.
- **Версия**: «Сборка от {versionFromLabel} → {versionToLabel}» (даты, не сырой CalVer).
- **Ошибка**: при `stage==='error'` — красный блок с `errorText` + подсказка (вкл. сценарий G42 emergency-update: «программа сама докачает установщик и перезапустится»).
- **Декор «летающие запчасти»**: 6–10 CSS/inline-SVG фигур (шестерёнка/болт/поршень/гайка/кольцо) за контентом (`z-index:-1`, `pointer-events:none`), CSS-keyframes дрейф/вращение; `@media (prefers-reduced-motion: reduce)` → анимация off (статичные/скрыты). Без внешних ассетов (CSP `'self'`).
- Лог — свернуть в раскрываемую «Подробности» (не основной фокус).

**4. Dev-симуляция (харнесс верификации)** — без реального релиза:
- `simulateUpdateUiForDev(scenario)` в updateService: открывает окно и прогоняет `updateUiViewState` по скрипту (`checking`→`downloading` с тиками pct/transferred→`verifying`→`installing`→`restarting`; и вариант `error`). Gated на dev (env `MATRICA_CDP_PORT`/`NODE_ENV`, как CDP-свитч — в проде не выставлен).
- Триггер: IPC-канал `update:simulate` в [src/main/ipc/register/update.ts](../electron-app/src/main/ipc/register/update.ts), вызывается из CDP-драйвера (`window.matrica`…) или dev-меню.

## Файлы
- `electron-app/src/main/services/updateService.ts` — модель состояния, `setUpdateStage`/`setDownloadProgress`, лейблы CalVer, `simulateUpdateUiForDev`.
- `electron-app/src/renderer/public/update.html` — полный rewrite (степпер/прогресс/версия/ошибка/декор/reduced-motion).
- `electron-app/src/preload/update.ts` — тип `UpdateState` (TS-зеркало).
- `electron-app/src/main/ipc/register/update.ts` — dev-триггер `update:simulate`.
- Reuse: `formatCalverBuildDate` (`@matricarmz/shared`).

## Verification
- `corepack pnpm -F @matricarmz/electron-app typecheck` + `lint`.
- **CDP-симуляция (verifier-electron):** окно обновления — отдельный BrowserWindow → отдельный target в `/json/list`. Драйвер вызывает `update:simulate` для каждого сценария, цепляется к target окна, снимает **DOM-факты**: степпер подсвечивает верный этап; строка прогресса показывает МБ/скорость/ETA; версия — даты (не сырой CalVer); error-сценарий красный блок + текст; декор-элементы présents; `prefers-reduced-motion` (CDP `Emulation.setEmulatedMedia`) → анимации off. Скриншот окна обновления попробовать (отдельное окно может не висеть как главное); fallback — DOM-факты.
- Прогон по всем стадиям доказывает UI без реального апдейта.

## Rollout
Client-only (renderer + main), без миграций. Поедет со следующим релизом (первым CalVer). Согласуется с CalVer: лейблы версий — даты сборки (закрывает отложенный «display даты CalVer» из плана calver). Декор/прогресс — чистый CSS/rAF, без зависимостей.

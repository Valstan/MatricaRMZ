# ADR-0001 — Архитектура установки и обновления Windows-клиента: аудит и дорожная карта

- **Статус:** Proposed (аудит готов; реализация — отдельными релизами по плану ниже)
- **Дата:** 2026-05-30
- **Контекст-источник:** директива brain `2026-05-28-install-update-architecture-audit.md` (compliance=recommend, normal)
- **Связанные:** план [`refactor-updater-2026-05.md`](../plans/_archive/refactor-updater-2026-05.md), [ADR-0002 brain (PR-only flow)](../../../brain_matrica/adr/0002-pr-only-flow-no-direct-push.md)

## Контекст

Владелец поставил стратегическую задачу: **устойчивость прода + дешёвые обновления** — чтобы клиент скачивал меньше (не тащил неизменившийся Electron каждый раз), не накапливал мусор при установке/обновлении, и чтобы «ломалась только часть, а не весь клиент». Brain прислал рамку аудита из 6 блоков и современные практики 2026. Этот ADR — результат аудита кодовой базы и прод-контура (read-only, без правок прод-кода). Реализация — отдельными релизами после.

**Главный вывод сразу:** рекомендация brain «включить дифференциальные обновления electron-builder из коробки» **не применима напрямую**, потому что MatricaRMZ осознанно **заменил `electron-updater` на собственный torrent/LAN/server-апдейтер**. Выигрыш «качать меньше» достижим, но требует реализации blockmap-diff **внутри кастомного загрузчика**, а не включения флага. Подробности — Блок 3.

---

## Блок 1 — Файловая раскладка установленного клиента

**Статус: отложен (нужна машина с установленным клиентом).** На dev-машине PC40 клиент не установлен (`%LOCALAPPDATA%\Programs\MatricaRMZ` отсутствует), live-аудит раскладки/мусора невозможен здесь.

Ожидаемая раскладка (выводится из конфига `electron-app/package.json` → `build`):
- `nsis.oneClick: true`, `nsis.perMachine: false` → **per-user** установка в `%LOCALAPPDATA%\Programs\MatricaRMZ`.
- userData (SQLite-кэш, логи, настройки) → `%APPDATA%\MatricaRMZ`.
- Кэш загружаемого обновления → `userData/pending-update` (`DOWNLOAD_DIR_NAME = 'pending-update'`, `updateService.ts`).
- Лог клиента: `matricarmz.log` в userData (см. F4 в плане updater-рефакторинга).

**Что проверить вживую на машине оператора (deliverable Блока 1, отдельная сессия):**
- Накапливаются ли `pending-update/*.exe` после успешной установки (есть `clearPendingUpdate`, но проверить фактически).
- Остаются ли старые версии-папки `app-X.Y.Z` (NSIS oneClick обычно ставит in-place, дублей быть не должно — подтвердить).
- Ротация `matricarmz.log` (сейчас, похоже, без ротации — риск роста).
- Полная очистка на uninstall.

---

## Блок 2 — Текущий механизм обновления

**Инсталлятор:** NSIS, `oneClick: true`, `perMachine: false`, `arch: x64`, `language: 1049` (RU), кастомный `installer/installer.nsh`. Конфиг **inline** в `electron-app/package.json` → `build` (отдельного `electron-builder.yml` нет).

**Сборка (CI):** [`.github/workflows/release-electron-windows.yml`](../../.github/workflows/release-electron-windows.yml) на тег `v*` → `pnpm -C electron-app build` → `electron-builder --win --x64 --publish always` → публикует в GitHub Release `*.exe`, `*.blockmap`, `latest.yml`; затем `scripts/upload-yandex-disk.mjs` заливает `electron-app/release` на Yandex.Disk (полный installer).

**`.blockmap` генерируется и публикуется** (подтверждено на проде `/opt/matricarmz/updates/`: `MatricaRMZ-Setup-1.34.0.exe.blockmap` = **93 674 б (~91 КиБ)** рядом с `MatricaRMZ-Setup-1.34.0.exe` = **89 610 888 б ≈ 85 МиБ (≈89,6 МБ)**; `latest.yml` = 351 б с `sha512`+`size`, без поля `blockMap`).

**НО клиент не использует `electron-updater`.** В `electron-app/src/main` нет ни `autoUpdater`, ни `electron-updater`. Обновление — **собственный механизм**:
- `updateService.ts` — оркестратор: периодическая проверка (`UPDATE_CHECK_INTERVAL_MS = 30 мин`), скачивание в `pending-update`, проверка **sha256** полного файла, detached-spawn инсталлятора, broadcast прогресса в renderer.
- Получение метаданных: клиент опрашивает `GET /updates/latest-meta` (`{version,fileName,size,sha256}`), torrent-метаданные — `GET /updates/latest`, файл — `GET /updates/file/{name}`.
- `lanUpdateService.ts` — LAN peer discovery/registration (`listUpdatePeers`, `registerLanPeers`, локальный LAN-HTTP-сервер раздачи).
- Раздача с сервера: `backend-api/src/routes/updates.ts` + `services/updateTorrentService.ts` (`/updates/latest-meta`, `/updates/latest`, `/updates/file/{name}`, `/updates/latest.torrent`, `latest.json`, torrent-tracker). Статус-эндпоинт `/updates/status` (CLAUDE.md релиз-чек).
- Каскад источников (из плана updater-рефакторинга): **LAN-пиры → LAN HTTP → сервер → Yandex.Disk → GitHub → torrent**.

**Почему так (по дизайну):** завод = много клиентов в одной LAN + ограничения РФ-сети. P2P/LAN-раздача экономит внешний трафик (один клиент скачал — раздал соседям), а multi-source каскад даёт отказоустойчивость, которой нет у штатного `electron-updater` (один GitHub-feed).

---

## Блок 3 — Дифференциальные (delta) обновления

**Текущий размер закачки на одно обновление: полный installer ≈ 85 МиБ (89 610 888 б) каждый раз.** Delta не используется.

`differentialPackage` **не задан**, `nsis-web` target **не используется**, provider = `github`. `.blockmap` **генерируется и публикуется, но кастомным апдейтером игнорируется** — он качает полный `.exe`.

**Важно (корректировка рамки brain):** «включить differential из коробки» предполагает `electron-updater`. У нас его нет. Два пути к delta:

- **Путь A — вернуться на `electron-updater`** (provider `generic`/`github`, blockmap-differential). Дёшево по коду, но **ломает** кастомную P2P/LAN-раздачу и multi-source каскад, ради которых updater и переписывали. Регресс по отказоустойчивости и заводскому LAN-трафику. **Не рекомендуется.**
- **Путь B — реализовать blockmap-diff внутри кастомного загрузчика** (рекомендуется). Клиент уже имеет старый installer (или его blockmap) → качает новый `.blockmap` (~91 КБ) → вычисляет изменившиеся блоки → тянет только их (HTTP Range-запросы к серверу/LAN-пиру; для torrent — селективный выбор pieces). Сохраняет P2P/LAN/каскад. Формат `.blockmap` electron-builder открыт (gzip-JSON: список чанков с размером и хешем) — переиспользуемо без `electron-updater`.

**Ожидаемая экономия:** при релизе, меняющем только наш JS/asar (единицы МБ), закачка падает с ~85 МиБ до единиц МБ; неизменившиеся блоки Electron/Chromium не качаются — ровно сценарий владельца, без ручного дробления.

**Предусловия Пути B:** сервер/LAN-пиры должны поддерживать HTTP Range (nginx — да); хранить N последних `.exe` + `.blockmap` (уже храним 3, см. systemd-cleanup); клиент — кэшировать blockmap установленной версии.

---

## Блок 4 — Версия Electron и cadence

| Компонент | Сейчас | Замечание |
|---|---|---|
| `electron` | `^33.2.1` (≈ окт 2024) | Текущий stable — **Electron 42** (релиз 2026-05-07, Chromium 148 / Node 24); поддерживаемое окно — **40/41/42**. Наш **33 — ≈9 мажоров позади, давно EOL** (Electron 39 EOL 2026-05-05) → накопленные Chromium CVE = security-долг, не «новые фичи». |
| `electron-builder` | `^25.1.8` | Актуальная ветка — 26.x; апдейт желателен вместе с Electron. |
| `electron-vite` | `^2.3.0` | — |
| `better-sqlite3` | `^11.7.2` | **ABI-связь.** На клиенте собирается под ABI Electron, на backend — под ABI Node. **Один и тот же пакет/версия, две ABI.** Апгрейд Electron требует rebuild нативного модуля под новый ABI клиента. |

**Согласие с brain:** отдельный авто-обновляемый «канал Electron» — **антипаттерн** (ABI-связь с `better-sqlite3`/V8 сломает нативные модули). Развязка достигается тем же delta-механизмом (Блок 3): когда Electron не менялся — его блоки не качаются; когда менялся — качаются один раз вместе с релизом, собранным под него. Отдельный канал не нужен.

**Deliverable:** разрыв версий значителен (33 → 42, security-долг). План апгрейда — Electron поднять в поддерживаемое окно (40–42) **с обязательным rebuild `better-sqlite3`** под новый ABI + smoke-тест клиента (SQLite-миграции, IPC, печать). Electron 42 несёт Node 24 — проверить совместимость. Делать отдельным релизом, не смешивая с delta.

---

## Блок 5 — Модульность сборки и «центр связей»

Фундамент уже есть: **pnpm workspaces**, 6 пакетов. Граф внутренних зависимостей (из `workspace:*`):

```
shared   ← electron-app, backend-api, web-admin
ledger   ← electron-app, backend-api          (оба имеют prebuild: pnpm -C ../ledger build)
electron-app → shared, ledger
backend-api  → shared, ledger
web-admin    → shared
scripts      → (нет workspace-deps; ledger подключается не через workspace:*)
```
(подтверждено чтением всех шести `package.json` → `workspace:*`)

`shared` — листовая зависимость всех трёх приложений; `ledger` — обоих backend/клиента. Правка в `shared` задевает почти всё — главный кандидат на affected-гейтинг. **Affected-build тулинга нет** (`turbo.json`/`nx.json`/`lerna.json` отсутствуют). Сборка — ручные последовательности `pnpm -F <pkg> build` (релизный шаг CLAUDE.md: `-F shared -F backend-api -F web-admin build`); CI (`typecheck.yml`, `sync-contract.yml`) собирает безусловно, без path-фильтров.

**Рекомендация: Turborepo** (легче Nx, нативно ложится на pnpm). Даёт: граф из импортов автоматически («дорожная карта связей» — самоактуализируется, не ведётся руками); `turbo run build --filter=...[affected]` — пересборка только затронутого + downstream; remote/local cache. Защита от дрейфа (страх владельца «забыть связь»): типы в `shared` как единственный контракт границ + contract-тесты, гейтящиеся по affected-графу. Nx — мощнее, но тяжелее для нашего размера.

**Альтернатива «пока не нужно»:** если суммарное время сборки CI терпимо (typecheck ~1 мин, installer ~неск. мин) — отложить Turborepo до роста монорепо. **Решение: внедрять Turborepo при первом ощутимом росте времени CI; сейчас — задокументировать граф и завести `turbo.json` как low-risk эксперимент на ветке.** Метрику (время до/после) снять при внедрении.

---

## Блок 6 — НЕ дробить клиент на runtime-модули

Согласие с brain, прямой ответ на развилку владельца:
- **Дробление _сборки_ (Блок 5, affected-build) — да.** Безопасно, граф держит связи.
- **Дробление поставляемого клиента на независимо-обновляемые runtime-модули (module federation на десктопе) — НЕТ.** Для десктопного ERP это путь к version-skew, рассинхрону IPC/контрактов и костылям ремонта — ровно то, чего владелец боится.
- Цель «ломается часть, чиним пока остальное работает»: для **клиента** — единый атомарный артефакт (но маленький за счёт delta из Блока 3) + надёжный **rollback** на предыдущую версию при сбое апдейта (уже частично есть в плане updater-self-heal). Для **прода** — это про backend, и он **уже dual-instance** (`primary:3001` + `secondary:3002`); усилить можно staged rollout / health-gate между инстансами, а не дроблением Electron-клиента.

---

## Решение (поэтапный план, привязка к релизам)

1. **Этап 0 (этот ADR).** Зафиксировать находки и направление. Без кода.
2. **Этап 1 — Блок 1 live-аудит.** На машине оператора задокументировать реальную раскладку/мусор/ротацию логов. → пункты в PENDING. (Зависимость: установленный клиент.)
3. **Этап 2 — delta-обновления (Путь B), отдельный релиз.** Blockmap-diff внутри кастомного загрузчика: парс `.blockmap`, diff против установленной версии, Range-загрузка изменившихся блоков (сервер+LAN, затем torrent-pieces). Слить с веткой работ плана [`refactor-updater-2026-05.md`](../plans/_archive/refactor-updater-2026-05.md) — не параллельный переписыватель. Метрика: «было ~85 МиБ → стало X МиБ» на типовом релизе.
4. **Этап 3 — апгрейд Electron, отдельный релиз.** Поднять Electron до поддерживаемого major + `electron-builder` 26.x; **rebuild `better-sqlite3`** под новый ABI; smoke-тест клиента (SQLite-миграции, IPC, печать, автоапдейт). Не смешивать с delta.
5. **Этап 4 — Turborepo (опц.), при росте CI.** `turbo.json` + affected-CI; снять метрику времени сборки.

**Чего НЕ делать:** отдельный канал авто-обновления Electron (ABI); runtime-дробление клиента; ведение графа связей руками; срыв текущих ниток ради этого аудита.

## Последствия

- **+** Чёткое направление: delta даёт «качать меньше» без рискованного дробления; security-долг по Electron виден и спланирован; модульность сборки — эволюционно через Turborepo.
- **−** Delta (Путь B) — реальная инженерная работа (парс blockmap + Range/torrent-piece загрузка), не флаг. Это цена сохранения P2P/LAN-раздачи, которая для заводского LAN ценнее «из коробки».
- **Заметка по каскаду:** «torrent»-leg на клиенте (`tryDownloadFromTorrentPeers`, `updateService.ts:1058`) качает по **обычному HTTP** к пир-URL `/updates/file/...`; tracker — только для peer discovery, поэтому `webtorrent` в зависимостях клиента нет и не нужен (он лишь в backend-api для трекера/раздачи). Реальный связанный followup — `infoHash:null` на secondary, влияющий на peer discovery через secondary.

## Adaptation notes (для возможной cross-project pool-идеи brain)

- Рекомендация #(delta) «electron-builder differential из коробки» **не переносится** на проекты, заменившие `electron-updater` кастомным апдейтером. Обобщение: «delta = blockmap-diff; если апдейтер кастомный (P2P/LAN/multi-source ради офлайн/заводской сети), delta реализуется поверх формата `.blockmap` вручную, сохраняя кастомную раздачу». GONBA (тоже pnpm-монорепо) — Electron-часть специфична только для MatricaRMZ, переносим лишь вывод про Turborepo affected-build.
- «Центр дорожной карты связей» = task-graph тул (Turborepo/Nx), граф из импортов — подтверждено, переносимо на любой pnpm-монорепо.

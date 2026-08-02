# Android-клиент для цехового планшета (Capacitor-порт)

**Status:** ACTIVE — утверждён владельцем 2026-08-02 (Android-планшет куплен, обмен на Windows x64 не рассматривается)
**Created:** 2026-08-02
**Родитель:** [`tablet-shop-floor.md`](tablet-shop-floor.md) — цель и производственный сценарий те же (обход цеха: галочки наличия, дефектовка, комплектность, офлайн + автосинк). Меняется только платформа клиента: вместо «Windows-планшет + Electron» — **Android-планшет + Capacitor-обёртка того же renderer**.
**Разведка:** два workflow-прогона 2026-08-02 (14 агентов: sync-протокол, web-admin, переносимость renderer, локальная реплика, drizzle-аудит, инвентаризация моста, boot-контракт, внешний стек; ключевые утверждения проверены адверсариально по коду).

## Рамка от владельца (2026-08-02)

**В цехе нужно:** карточка двигателя — **дефектовка и комплектность** (галочки на деталях + количества), **наряды** выписывать/заполнять, **ремфонд** вести (что отремонтировано), **документы склада** — приход/расход/ремфонд.

**НЕ нужно на планшете:** печать и печатные формы, контракты, отчёты, BOM, заявки, справочники, чат, AI, вложения (в v1). Остальные разделы добавляются «по ходу пьесы» — архитектура порта обязана позволять это без переделки фундамента (новый раздел = включить страницу + доложить методы моста).

## Почему порт реален (итог разведки)

- **Renderer чист:** ноль импортов Electron/Node, ноль прямых fetch — 924 обращения только через `window.matrica` (все лениво, внутри функций); контракт типизирован (`MatricaApi` в `shared/src/ipc/types.ts`). CSP `script-src 'self'` совместим с Capacitor-origin (шим — same-origin файлом, НЕ inline). Планшетный UI-режим Ф1 (v2026.722.917) — чисто веб-детекция, заработает на Android как есть.
- **Слой данных почти async-ready:** 352 обращения к drizzle — все `await`-стиль; `db.transaction()` нет вообще; sync-транзакций better-sqlite3 ровно 2 (обе в `syncService.ts:784,826`). Сырой SQLite сосредоточен в 4 файлах (`db.ts`, `migrate.ts`, `clientSchemaMigrations.ts`, `syncService.ts`) + синглтон `getSqliteHandle()`. Схема (`database/schema.ts`) — только `sqlite-core`, драйверо-независима.
- **Sync-протокол — чистый HTTPS+JSON:** push `POST /ledger/tx/submit`, pull `GET /ledger/state/changes`, cold-start `GET /ledger/state/snapshot` постранично. Криптография ledger целиком серверная, клиенту не нужна. Конфликты (LWW + tombstone + stale-seq) решает сервер; RBAC на запись (`partitionLedgerInputsByAuthz`) и фильтрация pull — серверные, тонкий клиент ничего не обходит.
- **Расписание синка** живёт в main-процессе (`syncManager` — dependency-free, портируется как есть); renderer сам синк не планирует, только слушает `sync.onProgress`.
- **Мост для рамки MVP — ~100 методов** из ~380 полного моста (инвентаризация по import-closure планшетных экранов; полный список — в артефактах разведки, восстановить: grep `window.matrica` по файлам страниц MVP).

## Целевая архитектура

```
android-app/  (новый пакет монорепо)
├── capacitor.config.ts, android/          # Capacitor 8 shell (minSdk 24, target 36)
├── vite.config.ts                         # root → ../electron-app/src/renderer (реюз UI без выноса)
├── src/
│   ├── bridge/                            # window.matrica шим: реализация ~100 методов
│   ├── core/                              # портированные сервисы (импорт из electron-app/src/main через Vite-alias + шимы)
│   ├── shims/                             # node:crypto→WebCrypto, netFetch→fetch/CapacitorHttp,
│   │   authService→secure-storage, settingsStore(sysDb), env-флаги через Vite define
│   └── db/                                # drizzle sqlite-proxy driver поверх @capacitor-community/sqlite,
│       async-фасад для getSqliteHandle(), порт двух миграторов
```

**Стек (внешняя разведка, версии на 2026-08):**
- **Capacitor 8** (2025-12): WebView, minSdk 24; `window.print`/`window.open` в WebView не работают — нам и не нужны (печать вне рамки).
- **БД:** `@capacitor-community/sqlite` v8.1+ (жив, мейнтейнер Capawesome; SQLCipher на Android — шифрование реплики сохраняем). Drizzle через `drizzle-orm/sqlite-proxy`. **Риск производительности:** мост Capacitor сериализует JSON (~1k строк/с через executeSet по issue #331) — холодный синк ~200k entities + 350k attribute_values обязан идти через `importFromJson`/чанки; если спайк-бенч провалится — запасной план `@capgo/capacitor-fast-sql` (обход моста по локальному HTTP, тоже SQLCipher).
- **Токены:** `@aparajita/capacitor-secure-storage` (Android Keystore AES-GCM) вместо `safeStorage`. Fail-closed правило сохраняем: нет Keystore → сессия только в памяти.
- **Сеть:** browser `fetch` + `navigator.onLine` вместо `electron net`. Если прод-CORS окажется allowlist — CapacitorHttp (нативный транспорт, CORS не касается) либо добавить origin в `MATRICA_CORS_ORIGINS`.
- **APK:** сборка в GitHub Actions, раздача вне Play Store (sideload, парк 1–5 планшетов, MDM не нужен: разовый тумблер «неизвестные источники» на устройстве). Самообновление — `@m430/capacitor-app-install` (тот же ключ подписи; Android 14 update-ownership благоволит самообновлению). Опция позже: `@capgo/capacitor-updater` для OTA web-бандла (renderer-only правки без переустановки APK).
- **Камера (Ф-развитие):** `@capacitor-mlkit/barcode-scanning` (`startScan()` — офлайн, без Play-модуля), фото дефектов через `@capacitor/camera`.

**Ключевые решения:**
1. **Renderer НЕ выносим из electron-app** (v1): `android-app/vite.config.ts` указывает root на `electron-app/src/renderer`, шимы и мост подключаются собственным `index.html` + alias'ами (`node:crypto`, `./netFetch.js`, `./authService.js` → android-реализации). Физический вынос в отдельный пакет — только если алиасный путь упрётся (отдельным рефакторингом).
2. **Портируемые сервисы импортируются из `electron-app/src/main` напрямую** (Vite-бандлу всё равно на rootDir): чистые — как есть (engineService, entityService, workOrderService, checklistService, supplyRequestService, cardDraftsService, operationService, auditService, adminService, settingsStore, syncManager, warehouseCommandOutboxService, engineReservationClient, erpService…); 17 файлов с `node:crypto` — через alias-шим; syncService — единственный, кому нужна правка по месту (2 sync-транзакции → async, `app.relaunch`/`fs.rm` в reset-флоу → платформенный хук). Правки в electron-app оформляются так, чтобы Windows-клиент не менялся поведенчески (гейты обязаны остаться зелёными).
3. **Миграторы:** drizzle-цепочка 0000–0020 — plain SQL, бандлится строками (vite plain-text) и катится через async-раннер по `_journal.json`; ⚠️ `0007` содержит `PRAGMA foreign_keys=OFF/ON` — раннер не должен оборачивать миграцию в транзакцию (PRAGMA внутри транзакции — тихий no-op). `clientSchemaMigrations` (v12) — сигнатуры уже async, `sqlite.exec/prepare` → awaited-фасад, `createHash` → `crypto.subtle`.
4. **Меню:** новый пресет `ANDROID_TABS ⊂ TABLET_OPERATOR_TABS`: **Двигатели, Наряды, Документы склада, Ремфонд** (stock_documents в июльском пресете не было — добавляется; Детали/Марки/BOM/Остатки/Заявки/Нормы — вне рамки v1). Платформенный флаг (`MATRICA_PLATFORM=android` через Vite define) прячет печать-кнопки, вложения, вкладку платежей, чат/AI.
5. **Идентичность клиента:** `clientId` = `android-<uuid>` в Preferences + БД (переживает пересоздание БД); heartbeat `GET /client/settings` с `platform=android` (сервер принимает free-form) + реализация админ-команд `force_full_pull`/`reset_sync_state_and_pull`/`deep_repair`/`sync_now` — иначе планшет невидим для флот-инструментов web-admin.
6. **Файлы/вложения в v1 скрыты** (файловые диалоги ОС не портируются; Яндекс.Диск-доступ с цехового Wi-Fi не проверен). Возврат — в Ф-развитии через камеру/Blob-канал (потребует нового bridge-метода upload-from-Blob и мелкой правки fileService).

## Серверные изменения (малые, отдельным PR)

- **nginx: `client_max_body_size` для `location /ledger/`** — сейчас наследует дефолт **2m** (20m стоит на мёртвом `/sync/`); Electron-клиент живёт только на row-каппах и 413 не обрабатывает. Поднять до 20m + в android-клиенте добавить байтовый чанкинг пуша (норм и для Electron — перенести туда же при случае).
- **Проверить прод-env** (`/etc/matricarmz/matricarmz.env`): `MATRICA_CORS_ORIGINS` (пусто = allow-any → Capacitor-origin работает сразу), `SYNC_V2_ENFORCE`, `MATRICA_LEDGER_E2E` (ожидается off — E2E-шифрование полей не портируем).
- **(опц.) Раздача APK**: v1 — GitHub Releases (планшету нужен доступ к github.com) или копия в `/opt/matricarmz/updates/` + статический route; решить в Ф4.

## Фазы

**Ф0 — Спайк (гейт всего плана).** ✅ *Браузерная половина сделана 2026-08-02:* пакет `android-app/` (Vite root → `electron-app/src/renderer`, стаб-мост ~15 методов) собрал ВЕСЬ renderer plain-Vite за ~32 с, логин-экран рендерится вне Electron (скриншот headless Chrome). Остаток Ф0 — Capacitor-shell + SQLite-бенч на купленном планшете (нужна модель устройства). Исходный объём: standalone Vite-сборка renderer + стаб-мост (~12 методов boot-контракта: `auth.status`, `settings.uiGet/uiControlGet/releaseWelcomeGet`, `sync.status`, `backups.status`, `server.health`, `app.version`, `auth.loginMru/loginSuggest`, `engines.list`, `log.send`) → логин-экран в браузере/эмуляторе. Capacitor-shell на купленном планшете. **Бенч SQLite:** importFromJson/executeSet на 100k+ строк на реальном железе → выбор плагина (community vs fast-sql). Провал бенча = пересмотр стека до начала Ф1.

**Ф1 — Фундамент (самая тяжёлая).** Шов драйвера (sqlite-proxy + async-фасад `getSqliteHandle`), оба мигратора, шимы netFetch/authService/crypto/env, порт syncService (2 транзакции, reset-флоу без relaunch) + syncManager, auth (login/refresh/secure-storage), clientId + heartbeat + админ-команды. **Выход:** холодный полный pull прод-масштаба на планшете + push тестовой правки, повторные инкременты.

**Ф2 — Двигатели.** Мост для engines/operations/checklists/admin.entities/employees/audit/drafts + список двигателей, карточка, **дефектовка и комплектность офлайн** (NumpadOverlay уже есть), резервирование «Взять в работу» (engineReservationClient — HTTP, офлайн-release уже в syncManager). Платформенные скрытия. **Выход:** обход цеха без сети с галочками/количествами, синк при появлении Wi-Fi.

**Ф3 — Наряды + склад.** workOrders local-set (create/update/list/get, createRepairFromDefects — всё локально-офлайн; сборочные действия close/issue/post — онлайн как на десктопе), StockDocumentsPage/Details + warehouseCommandOutbox (офлайн-очередь документов уже существует — портируется), RepairFundAuditPage. **Выход:** полная рамка владельца.

**Ф4 — Канал раздачи.** CI-сборка подписанного APK (workflow_dispatch → release-артефакт), инструкция первичной установки, самообновление in-app, решение по хостингу APK. Обкатка на пилотном планшете.

**Ф-развитие (после обкатки):** камера-QR (скан клейма → карточка двигателя; `startScan` офлайн), фото дефектов в дефектовку, вложения через Blob-канал, доп-разделы меню по запросу, OTA web-бандла.

Оценка честная: Ф0 1–2 сессии, Ф1 3–5, Ф2 2–3, Ф3 2–3, Ф4 1–2 — порядка 2–4 недель сессионной работы до полной рамки. Узкое место — Ф1 (порт синка) и живой бенч Ф0.

## Риски

- **Производительность моста Capacitor на холодном синке** — главный технический риск; закрывается бенчем Ф0 до всяких обязательств (запасной путь — fast-sql).
- **Часы планшета:** LWW доверяет клиентскому `updated_at` (`normalizeRowTimestamps` только заполняет пропуски) — кривое время тихо выигрывает/проигрывает конфликты и ломает 15-мин grace резервирования. На Android NTP обычно автоматом; добавить сверку с сервером на логине (варнинг при дрейфе > 2 мин).
- **Носимое устройство с 30-дневным refresh-токеном и репликой** (RBAC-фильтрованной) — регистрации устройств на сервере нет, API публичен. Политика та же, что была бы у Windows-планшета; шифрование реплики (SQLCipher) + Keystore сохраняем. Отдельный device-gate — только по решению владельца (новая серверная работа).
- **Двойная поддержка клиентов навсегда** — цена решения Android (июльский план это и предсказывал). Митигация: renderer/shared/сервисы общие, платформ-специфика изолирована в шимах; правки в общих сервисах гоняются гейтами обоих клиентов.
- **Wi-Fi покрытие цеха / доступ к github.com и Яндекс.Диску** с планшета — не проверено полевым фактом (файлы в v1 не нужны, но канал APK — нужен).

## Открытые вопросы владельцу

1. **Модель купленного планшета** (Android-версия, диагональ, RAM) — нужна для Ф0-бенча и проверки minSdk 24.
2. Кто носит планшет в пилоте (мастер / двигателист) — стартовый экран (по июльскому плану — список двигателей).
3. Допустима ли текущая политика доступа (токен+реплика на носимом устройстве без device-gate) — или заказываем серверный allowlist устройств.

## Что заменяет / отменяет

- Июльское решение «вариант A: Windows-планшет» ([`tablet-shop-floor.md`](tablet-shop-floor.md)) — **заменено** решением владельца 2026-08-02 (куплен Android). Наработки Ф1 (UI-режим), Ф2 (резервирование, серверная часть), упрощённое меню — **переиспользуются целиком**.
- Оценка «вариант B = месяцы, переписать всё» уточнена разведкой: renderer и sync-протокол переносимы, переписывается только хостинг сервисного слоя (недели).

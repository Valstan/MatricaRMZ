# Пакет владельца 2026-08-19(б): синк-баг, чат, файлы, журнал, рабочий стол, отчёты, ИИваныч

> **Status: ACTIVE** · заведён 2026-08-19 (сессия rmz4val). Разведка: 3 Explore + Plan-агент, ссылки на код верифицированы. Прогресс этапов отмечать здесь же.


## Контекст

Владелец продиктовал пакет из ~14 пунктов: баг «выкидывает из программы при синхронизации» (+ потеря закреплённых кнопок после обновления — тот же корень), реорганизация чата под мессенджер, drag&drop файлов, объединение списков вложений, дотошный журнал действий, «Рабочий стол» программы, консолидация отчётов по двигателям, ИИваныч-помощник по отчётам. Разведка (3 Explore-агента + Plan-агент, все ссылки на код верифицированы) показала: баг — системный (6 путей разлогина, главный — пересборка клиентской БД по смене серверного схема-хеша, стирающая несинканные правки), а для большинства фич уже есть готовые механизмы переиспользования.

**Решения владельца (2026-08-19):** баг первым; «Рабочий стол» = стартовый экран после входа; отчёты по двигателям объединить + убрать мёртвый; доступ к журналу — выдаваемое право (сразу выдать Сапегину).

**Ограничения:** EAV-freeze (новые данные — строгие таблицы; но расширение существующего `ui_profile_json` — не новая EAV-сущность, допустимо); presence-подобное НЕ пускать в ledger (тест `presenceNotLedgered`); прод обновляется автоапдейтером — порядок раскатки сервер→клиент важен.

## Этапность (каждый этап = свой релиз, порядок фиксирован)

| Этап | Что | Пункты владельца |
|---|---|---|
| 1 | P0: не выкидывать и не забывать (синк + roaming настроек) | 1, 2 |
| 2 | Чат-мессенджер + drag&drop в чат + «Правка программы» | 3, 4, 5, 6(чат) |
| 3 | Вложения: единый модуль, d&d, «Сохранить все» | 6, 7, 8 |
| 4 | Журнал действий + «История изменений документа» | 9 |
| 5 | Рабочий стол | 10 |
| 6 | Отчёты: объединение + фильтры UX + «Популярные» | 11, частично 12 |
| 7 | ИИваныч: подбор отчётов, популярные настройки | 12, 13 |
| — | Пункт 14 (процесс): запись в `PENDING_FOLLOWUPS` §Календарь «раз в 2 недели — сессия проверки перекосов (отчёты после структурных изменений)» | 14 |

---

## Этап 1 (P0). Синк не выкидывает и не теряет; настройки едут за пользователем

> **Этап 1 закрыт кодом 2026-08-19** (PR [#632](https://github.com/Valstan/MatricaRMZ/pull/632), [#633](https://github.com/Valstan/MatricaRMZ/pull/633), [#634](https://github.com/Valstan/MatricaRMZ/pull/634), [#635](https://github.com/Valstan/MatricaRMZ/pull/635), [#636](https://github.com/Valstan/MatricaRMZ/pull/636)) — все в `main`, на прод **ещё не выкачено** (нужен деплой backend + релиз клиента). Ниже исходный план этапа сохранён как история решений.


Диагноз (верифицирован построчно): сессия лежит в `sync_state['auth.session']` внутри той же sqlite, которую sync сам удаляет. Пути разлогина: **H1** schema-hash mismatch → `resetLocalDatabase` ДО push'а pending (`syncService.ts:2996-3011`, `clientSchemaMigrations.ts:590`; любая backend-миграция sync-таблицы флипает хеш → backend-only релиз пересобирает ВЕСЬ парк ≤6ч; `.catch`→rebuild даже на transient; **rebuild не меняет клиентскую схему — разрушает данные, ничего не чиня**); **H2** гонка ротации refresh-токена (3 семейства рефрешеров, ротация без grace, `auth.ts:590-600`); **H3** transient-ошибки сервера → 401/`user disabled` → clearSession (хвост M28); **H4** 403 permissions = «сессия невалидна»; **H5** boot self-heal стирает сессию; **H6** `repairLocalSyncTables` удаляет pending-строки, full-pull чистит после проглоченного фейла push, `clientAdminService` зовёт `runSync` мимо inFlight-guard.

### PR-1 — backend (деплой ПЕРВЫМ, обратно совместим)
1. **Grace-window ротации refresh** (`backend-api/src/routes/auth.ts:590-600`): вместо DELETE старого токена — `expiresAt = min(expiresAt, now+60с)`; + чистка протухших. Без миграции.
2. **`requireAuth` → 503 на infra-ошибках** (`backend-api/src/auth/middleware.ts:20-37`): ошибка/недоступность EAV-дефов → 503 (старые клиенты 503 игнорируют — безопасно); `user disabled` (403) только при загруженных дефах и реально `accessEnabled:false`; машиночитаемые `code` в телах auth-ошибок.

### PR-2 — electron-app (после деплоя PR-1; можно 2a auth + 2b sync-safety)
3. **Убрать blanket-rebuild** (`clientSchemaMigrations.ts:590-592`): hash mismatch → `action:'server_schema_changed'` (не rebuild) → `alignSchemaWithServer` + repair, синк продолжается. Rebuild остаётся только для даунгрейда версии/битой цепочки миграций. `.catch` → `check_failed` → лог и продолжить. Зеркало — `android-app/src/db/migrations/clientSchemaCompatible.ts`. Опционально: хеш по клиент-релевантному подмножеству (пересечение колонок реплики, `{name,notNull}`). Аварийный ручной wipe — команда `rebuild_local_db` в `clientAdminService` (через экспорт из п.4).
4. **Rebuild никогда не теряет несинканное**: `exportPendingRows` (реюз `collectPending`) → JSON в userData до любого `rm` в `resetLocalDatabase:2764` + best-effort push; replay после первого успешного pull (LWW по `updated_at`, `sync_status='pending'`); файл не удаляется, пока не реплеен.
5. **Сессия переживает пересборку**: sidecar `%APPDATA%\MatricaRMZ\auth-session.json` (DPAPI, зеркало `clientIdStore.ts`); `clearSession(db,{includeSidecar})` — sidecar чистят только явный logout и дефинитивный 401; `resetLocalDatabase` — нет.
6. **Single-flight refresh** в main (`authService.ts`: один in-flight promise; внутри — перечитать токен из `getSession`).
7. **Только дефинитивный отказ чистит сессию**: refresh только на 401 (убрать 403-триггеры в `httpClient.ts:62-87`, `fetchAuthed:715`); фейл самого refresh-запроса (timeout/5xx) сессию НЕ чистит; 403 на sync (`syncService.ts:3047/3144/3252`) → типизированная ошибка «нет права синхронизации», сессия живёт; `user disabled` — по `code`, фолбэк на текст.
8. **Data-safety**: `repairLocalSyncTables` — guard `sync_status NOT IN ('pending','error')` на все DELETE, survivor-приоритет pending; full-pull clear только при чистом push и нуле pending (pure-хелпер `shouldClearBeforeFullPull`); `clientAdminService:219/230/241/278` → через `mgr.runOnce`.

### PR-3 — backend: ui-profile merge (деплой до PR-4)
9. `setEmployeeUiProfile` (`employeeAuthService.ts:644-657`) → **merge с per-key LWW**: `keyUpdatedAt: Record<string,number>` в `UserUiProfile`; отсутствующий ключ = не трогаем (уже это чинит стирание `aiChatTemplates` старыми клиентами).

### PR-4 — electron: roaming настроек
10. Чинить push-эффект `App.tsx:1793-1815`: не помечать профиль ready при фейле GET (ретрай), sig ставить после успешного PATCH, слать частичный патч + `keyUpdatedAt`.
11. **`shellPrefs` в профиль** (roaming-подмножество: buttonLayout/pinned/columns/workspaceMode, БЕЗ session-вкладок): локальный blob остаётся источником оффлайна, overlay по LWW при логине. Мутации пинов — только по raw stored списку, не по отфильтрованному (`v2ButtonCatalog.ts:122-124` фильтр остаётся render-time) → id-чурн больше не стирает пины.
12. **PR-5 (follow-up)**: `columnLayouts` в профиль + user-scoped ключ localStorage (`matrica:columnLayout:<userId>:<id>`, миграция legacy-ключа).

**Тесты этапа**: unit — `ensureClientSchemaCompatible` (mismatch→не-rebuild, downgrade→rebuild, throw→не-rebuild), export/replay round-trip, single-flight (5 конкурентных → 1 HTTP), grace-window (supertest), middleware (throw→503, null→503, disabled→403), merge-LWW матрица, `shouldClearBeforeFullPull`. E2e (`verifier-electron`): бэкенд остановлен посреди сессии → нет разлогина; правка роли → нет разлогина; подмена хеша → нет wipe; pending + deep_repair → строка жива; удалить sqlite → relaunch → сессия и пины на месте.

---

## Этап 2. Чат-мессенджер + «Правка программы»

> **Этап 2 закрыт кодом 2026-08-19** (PR [#640](https://github.com/Valstan/MatricaRMZ/pull/640)) — чат-мессенджер (колонка собеседников, разделители дат, свои/чужие пузыри, действия под сообщением, drag&drop файлов, «Сохранить все») и кнопка «Правка программы» (4 типа, раздел подставляется сам, доставка личным сообщением суперадмину одним сообщением с переходом на экран). Отдельно: печать и настройка колонок на экране **Склад → Номенклатура** ([#639](https://github.com/Valstan/MatricaRMZ/pull/639)) — ответ на вопрос владельца о «справочниках».


Всё в `ChatPanel.tsx` (816 строк, единственный файл UI чата) + `chatService.ts`. Сообщения = плоская таблица `chat_messages` (личный = `recipient_user_id`), WebSocket нет (поллинг 30/60с) — макет меняем, транспорт не трогаем.

1. **Макет**: левая колонка — все пользователи (реюз `GET /chat/users`), онлайн/офлайн (presence уже есть, окно 5 мин), бейдж непрочитанных per-user (`chatUnreadCount.byUser` уже считается); справа — лента выбранной беседы (общий чат — первый пункт списка).
2. **Лента**: разделители-даты (группировка по московскому дню, `formatMoscowLongDateTime` есть); свои сообщения — белый фон справа, чужие — голубоватый слева (токены в `theme.colors`, убрать хардкод `#fff7ed`); **вместо кнопки «i» — строка под сообщением**: дата + Ответить / Ответить лично / В заметки / Удалить (обработчики готовы: `handleReply/handleReplyPrivate/openNoteDialog/handleDeleteMessage`, `ChatPanel.tsx:689-720`).
3. **Drag&drop в чат** (мультифайлы): реюз паттерна `AttachmentsPanel.tsx:426-442` → preload `webUtils.getPathForFile` → `files:registerDropped`; N файлов = N file-сообщений (лимит 20МБ/файл действует).
4. **«Сохранить все»**: в ленте выбор файлов/кнопка «Сохранить все файлы» → копирование в папку (реюз `filesDownload` + «Копировать в папку»).
5. **«Правка программы»**: глобальная кнопка в полосе вкладок v3 (`V3TabShell.tsx:364-390`, между спейсером и аккаунтом) + пункт в МЕНЮ (`menuActions.ts`, `handleMenuAction`). Модалка: тип (Замечание/Вопрос/Поправить/Добавить) + текст. Отправка = обычное личное chat-сообщение суперадмину (`usersList().find(role==='superadmin')` — паттерн pending-чата `ChatPanel.tsx:188`) с `payload_json` = `currentAppLink` (`App.tsx:3569`, готовые breadcrumbs «в каком разделе создана правка») и префиксом типа. Новая sync-таблица НЕ нужна.
6. Попутно: гейт `chat.use` в IPC чата (сейчас только live-mode), выравнять `sysDb`/`dataDb` в chat-IPC, убрать мёртвые пропсы.

## Этап 3. Вложения: один модуль вместо двух списков

Два списка = `EnginePhotoGallery` + `AttachmentsPanel` над ОДНИМ массивом `attributes.attachments` (`EngineDetailsPage.tsx:2239-2254`), у каждого свой selection и свой набор кнопок. Делаем единый компонент: сетка миниатюр (картинки) + таблица (все файлы) с **общим selection и единым тулбаром** (объединение наборов: добавить/вставить/камера/печать/PDF-сборка/копировать в папку/шаринг/устаревшее/удалить + новая **«Сохранить все»**). Drag&drop уже есть в панели — покрыть весь компонент (и все места использования: карточки контракта, чек-листы). Попутно: передавать `scope` с карточки двигателя (файлы перестанут падать в плоскую папку Яндекса).

## Этап 4. Журнал действий пользователей

Фундамент есть: `audit_log` (synced) → проекция `statistics_audit_events` + дневной rollup (`statisticsAuditService.ts` уже классифицирует, формулирует по-русски, даёт deep-links) → UI `SuperadminAuditPage.tsx` «Журнал действий пользователей».

1. **Телеметрия**: `ui.card_open` дополнить `entityId` (сейчас пишется только тип карточки) + событие редактирования для остальных карточек (образец `ui.engine.edit_done`); `ui.report_build` с санитизированной картой фильтров (нужно и этапу 7). Троттлинг 30с сохранить; прикинуть ретеншн audit_log.
2. **Право** `audit.view` (superadmin всегда; выдать Сапегину при релизе; выдаётся из админки как остальные права).
3. **«История изменений этого документа»**: новый backend-endpoint «история строки» по ledger (`row_id` scan; каждый tx уже несёт `{table,row,actor,ts}`) + `audit_log`; панель в карточке (визуальный шаблон `EngineTimelinePanel`), кнопка в карточках двигателя/контракта, дальше по остальным.
4. Журнал-страницу перевести с жёсткого superadmin-гейта (`adminAudit.ts:12-16`) на право; фильтры/выгрузка — по мере надобности (rollup для статистики уже есть).

## Этап 5. Рабочий стол

1. Новая singleton-вкладка `desktop` (`tabsModel.ts` — паттерн `chat`/`settings`), **открывается первой после входа**.
2. Ярлык = `{appLink: ChatDeepLinkPayload, label, icon}` — реюз меток `TAB_SHORTCUT_META` (`HistoryPage.tsx:85-112`) и `buildChatBreadcrumbs`. Кнопка «На рабочий стол» рядом с «Ссылка в заметки» (`App.tsx:1953`, `saveCurrentPositionToNotes` — образец) + в карточках/списках/отчётах + из МЕНЮ.
3. Хранение — ключ `desktop` в `ui_profile_json` (merge-LWW из этапа 1 обязателен до этого) → синк между машинами бесплатно. Толерантность к неизвестным id — как у пинов (хранить, не рендерить).

## Этап 6. Отчёты по двигателям + фильтры

1. **Объединить** `engines_list` («Отчёт по двигателям», `reports.ts:1132`) + `engines_contracts_overview` («Двигатели и контракты», `:1207`) → один пресет «Двигатели»: superset колонок и фильтров, `groupBy`, обе кнопки `EnginesPage.tsx:745,751` → на него; старые id — алиасы (мигрировать сохранённые фильтр-шаблоны/избранное/историю по id); одна тема в каталоге вместо двух.
2. **Убрать из каталога** мёртвый `engine_movements` («Движение двигателей за период» — читает `operations`-типы, которые никто не пишет; на проде пуст); проверить/починить `engine_stages` (та же зависимость). «Движение по заказчикам» остаётся.
3. **Фильтры UX**: под каждым фильтром печатать выбранное («сводка выбора»), блок применённых фильтров над предпросмотром; шаблоны фильтров перенести с локального `client_settings` на сервер (в `ui_profile` — roaming + сырьё для этапа 7).
4. **Страница «Популярные отчёты»**: карточки (название + описание + состав фильтров) из `REPORT_PRESET_DEFINITIONS` + статистики использования (`aiUsageDigestService` уже агрегирует `ui.report_open`).

## Этап 7. ИИваныч и отчёты

Function calling уже развёрнут (`llmTools.ts`, 17 тулов, пер-тул permissions; `execute_safe_sql`; `attach_table` xlsx — «сам сделай отчёт» фактически умеет).
1. Тулы `list_report_presets` / `suggest_report` над `REPORT_PRESET_DEFINITIONS` (~40 строк) + `get_report_usage` над `statistics_audit_events`/`ui.report_build`.
2. Ответ ИИваныча со ссылкой-открытием отчёта: `ChatDeepLinkPayload` `{tab:'report_preset', presetId}` → `App.tsx:2831 openReportPreset` (рендер ссылки в `AiAgentChat`).
3. Предзаполнение популярных настроек фильтров по статистике `ui.report_build` (дефолт при открытии пресета, с пометкой «популярные настройки — сбросить»).

---

## Верификация (гейты AGENTS.md §Autonomy)

- Каждый PR: build `shared`+`ledger` → `corepack pnpm -r typecheck` (+ `typecheck:test` при правке тестов) + `lint` → `corepack pnpm -F @matricarmz/backend-api test` → CI зелёный.
- UI-этапы: CDP e2e-smoke на `verifier-electron` (на rmz4val: PG 5432 `postgresql-x64-17`, backend :3001; better-sqlite3 ABI-качель — `@electron/rebuild --force` перед Electron).
- Этап 1: сценарии из «Тесты этапа» + наблюдение парка после релиза (lastVersion, отсутствие волны релогинов после следующей backend-миграции).
- Раскатка каждой пары: backend-PR деплоится раньше клиентского релиза.

## Housekeeping

- План → `docs/plans/owner-batch-2026-08-19b.md`; `SESSION_HANDOFF` вести по нитке.
- `PENDING_FOLLOWUPS` §Календарь: пункт 14 владельца (двухнедельная проверка перекосов).
- Ответ владельцу по прошлой сессии («какой экран под печатью справочников») — остаётся открытым, не входит в этот пакет.

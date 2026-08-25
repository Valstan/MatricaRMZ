# Gotchas — проектные грабли по симптомам

> Symptom-keyed debug-рефлексы MatricaRMZ. **Грепай по симптому перед долгой отладкой** — дешевле, чем переоткрывать. `/start` это **не** читает. Кросс-проектные грабли — в `../brain_matrica/cross-project-ideas/GOTCHAS.md`.
>
> Формат: Tier-1 индекс (симптом → `M##`) → Tier-2 запись (Симптом / Корень / Диагностика / Лечение). Новые грабли добавляет `/close_session` при появлении.
>
> _Seed 2026-06-16 (реорг памяти, [план](plans/_archive/memory-reorg-2026-06.md)). Донаполнять по мере появления повторяемых грабель._

## Индекс

| # | Симптом | Область |
|---|---|---|
| M1 | `ssh matricarmz` — `Connection timed out` / banner-таймаут (а `ping` отвечает) | SSH / прод |
| M2 | `corepack pnpm -F electron-app test` падает `NODE_MODULE_VERSION 145 vs 137` | local / better-sqlite3 |
| M3 | `pnpm -r typecheck` даёт ложный `TS2305` на `@matricarmz/shared` | monorepo / typecheck |
| M4 | `dev:seed-fixtures` даёт ложный `exit 1` (на `console.warn`-stderr) | verify / PowerShell |
| M5 | `gh release download` с мульти-`--pattern` не качает `.blockmap` | релиз / updater |
| M6 | Серверный maintenance-скрипт пишет в БД, но изменения не доезжают клиентам инкрементально | server-script / sync |
| M7 | Прод-конфиг (sshd/nginx/systemd) ведёт себя странно, «забит нулями» | прод / хостер |
| M8 | Запись атрибута (`setEntityAttribute`) не прилетает клиенту инкрементальным pull | sync / EAV |
| M9 | `/updates/status` через secondary отдаёт старую версию / `infoHash:null` | updater / dual-instance |
| M10 | `drizzle-kit generate` уходит в интерактив «rename vs create» про чужие таблицы | drizzle / migrations |
| M11 | Окно печати (`openPrintPreview`): галка секции не показывает свою секцию / снял «Месяц целиком» → пустой лист | Electron / печать |
| M12 | dedupe-merge «нет складской карточки» / полный `replayLedgerToDb`-cold-rebuild падает на unique `code` | ledger / unique-index |
| M13 | dev: правки кода/роута «не срабатывают» (молчаливый no-op, эндпойнт не пишет) — а тесты/прямой вызов работают | verify / dev-backend |
| M14 | После релиза с новой outcome-телеметрией апдейтера — 0 `client.update.full_download` / 0 `update-applied` (выглядит как «дельта сломана») | updater / телеметрия |
| M15 | Standalone-скрипт пишет в sync/ledger (setEmployeeAuth и т.п.) → `sync_conflict` + `empty_recovery` (затирает ledger пустым) | server-script / ledger |
| M16 | `corepack pnpm install` на проде висит часами (зомби-процессы) — на postinstall `electron-app` | релиз / prod-deploy |
| M17 | Оператор: кнопка в UI есть, локально сохраняется, но `server.authz.denied` `forbidden:<type>` — запись не уходит | RBAC / sync / UI-server parity |
| M18 | Прод-деплой: `gh release download` с несколькими `--pattern` молча недокачал `.blockmap` → дельта релиза ломается | релиз / prod-deploy |
| M19 | `git rm --cached` / `git pull` / `reset --hard` на проде грозит удалить ЖИВЫЕ данные (ledger-блоки/ключи трекаются внутри checkout'а) | git-гигиена / прод / ledger |
| M20 | После `ledger-publish` (до рестарта) `/updates/status` показывает `stale_manifest`/старую версию/`infoHash:null` | релиз / updater |
| M21 | Починил `setEntityAttribute` (запись EAV) — а у двигателей всё равно не работает (свой путь `setEngineAttribute`) | EAV / write-path |
| M22 | Пустые списки нарядов/сущностей у всех после релиза изоляции (данные жёстко удалены purge с клиента) | sync / display-filter / data-loss |
| M23 | Значение застряло в СПИСКЕ, хотя в КАРТОЧКЕ правится и `setAttr` корректен — список читает ДРУГОЙ (legacy) атрибут | EAV / dual-source read |
| M24 | `db:migrate` на проде падает `must be owner of table X` — таблица создавалась вручную под `postgres`, а не под приложенческим юзером | миграции / PG ownership |
| M25 | `upsertWarehouseAssemblyBom` падает «в варианте __kit_* отсутствуют обязательные типы» при добавлении строк в base | BOM / full-replace валидация |
| M26 | JSON-атрибут EAV записан с двойной кодировкой (`setEntityAttribute` stringify'ит уже сериализованную строку) — читатели работают, идемпотентность видит пусто | EAV / JSON-кодировка |
| M27 | `nginx -s reload` применил конфиг (`nginx -t` ok), но изменённый `listen`-адрес не перевесился — старый сокет 0.0.0.0 остался | nginx / прод |
| M28 | Оба backend-процесса ~50% CPU, клиенты зависают/релогинятся, клиенты повторяют один `since` в `/ledger/state/changes` | sync / ledger / presence-амплификация |
| M29 | `gh release download` оборвался по таймауту → `.exe` **недокачан**, но лежит как «скачанный» (без ошибки); задеплоишь — updater отвергает по sha512 | релиз / prod-deploy / integrity |
| M30 | Прод-скрипт с записью в sync: `sync conflict rows skipped`, клиенты изменений не видят, в `ledger_tx_index` аномально низкие `server_seq` — env не просорсен, ledger паразитный | sync / ledger / prod-скрипты |
| M31 | Серверная запись ERP-таблицы через `recordSyncChanges`: ledger подписан, ошибок нет — а PG-строка не изменилась (в `applyPushBatch` нет ERP-веток) | sync / ERP / prod-скрипты |
| M32 | Сборочный наряд: двигатель в шапке выбран, а №/марка/договор/заказчик пусты (в печати, списке, отчёте) либо кнопка просит «укажите двигатель»; лечится ритуалом «убрать номер → сохранить → вернуть → сохранить» | наряды / двигатель шапки |
| M33 | Новое поле шапки складского документа «сохраняется», но после перезагрузки пусто (или не доезжает до движения регистра) | склад / документы / zod-strip |
| M34 | Мягкий гейт записи поставлен в `applyPushBatch` — отклонённые строки «воскресают» после ledger-replay / cold-rebuild | sync / ledger / гейты |
| M35 | Advisory-резерв двигателя не режет правку, которую «должен» — либо, наоборот, режет чужой контур (наряды, снабжение, склад) | резерв двигателя / охват гейта |
| M36 | Backstop по КОДУ атрибута обходится: клиент кладёт свой `attribute_defs` с защищённым кодом в том же батче и пишет значение по его id | sync / RBAC / backstop |
| M37 | Наряд «всплыл» с номером 0 (или получил свежий номер вместо своего) — данные карточки при этом пустые | наряды / recovery-черновик |
| M38 | Скрипт по `erp_*`-таблице отработал «успешно» (или упал `sync_invalid_row`), а в PG ничего не изменилось | server-script / sync / erp |
| M39 | Правка встала в UI и «везде», а через полминуты откатилась к прежнему значению | sync / серверный backstop |
| M40 | После релиза `/updates/status` пишет `stale_manifest`, а `/updates/file/<exe>.blockmap` отдаёт 404 | релиз / updater |
| M41 | Maintenance-скрипт отработал «успешно», но задел почти не тронут — строки ушли в корзину-исключение | server-script / прод-данные |
| M42 | Целый раздел UI отвечает «No handler registered for '…'» после чистки мёртвого кода | deadcode / IPC |
| M43 | У ВСЕХ клиентов разом падает pull `SQLITE_CONSTRAINT_*`, сервер здоров | sync / схема клиента |
| M44 | Watchdog рапортует `recovery succeeded (exit=0)`, а ярлыки так и не вернулись | watchdog / NSIS |
| M45 | Сохранение падает `<path>: элемент <uuid> не найден`, хотя объект в базе есть | ссылочный гард / клиент↔сервер |
| M46 | «Логин активен на 2 машинах» / парк клиентов «размножается», машины на древних версиях не гаснут | client_settings / identity |
| M47 | Клик мышью по элементу UI не срабатывает, а с клавиатуры то же действие работает | renderer / порталы |
| M48 | Операторы видят не все наряды подряд идущим куском, суперадмин видит все | доступы / изоляция нарядов |
| M49 | Данные, созданные на одной машине, не видит НИКТО; правка карточки «откатывается» после перезахода | sync / push-очередь / гарды |
| M50 | Кнопки UI «свалились в кучу» строками, у каждой жирная чёрная рамка — при зелёных typecheck/lint/тестах | renderer / CSS-импорт |
| M51 | Первая тяга разделителя панелей сдвигает его на пару пикселей и «отпускает» (повторная — работает) | renderer / resizable-panels |
| M52 | Строка создана на машине, «ошибок нет», но на сервер не доехала и не доедет никогда (`synced` без `last_server_seq`) | sync / push-очередь |
| M53 | Выбор в пикере ссылки «не применяется»: поле показывает новое значение, а после сохранения возвращается старое | renderer / контролируемые пикеры |
| M54 | UI-смоук «элемент найден» зелёный, а элемента на экране нет: список рендерит 0 строк при честном «Всего: N», доверенный клик уходит в пустоту | verify / CDP / v3-оболочка |
| M55 | Смоук «запись появилась» зелёный, хотя фича выключена — засчитана строка прошлого прогона | verify / CDP |
| M56 | Весь сетевой слой отказывает «offline» в vitest, хотя `fetch` замокан и сервер отвечает | android-app / шимы Node↔WebView |
| M57 | PR со сторожем: `go vet` и сборка зелёные, а чек semgrep красный от `unsafe` | watchdog / CI / SAST |
| M58 | Обновление «не находится и не скачивается», хотя прод раздаёт и delta считается: в логе `stale update lock removed` | updater / delta-кэш |
| M59 | Установщик отработал, файлы новые — а у оператора прежняя версия (старый процесс пережил установку) | installer / ручная установка |
| M60 | Новый workflow смержен в main, но `gh workflow run` отвечает 404 «not found on the default branch» | CI / GitHub Actions |
| M61 | Android: boot падает «Queries can be performed using SQLiteDatabase query or rawQuery methods only», хотя все тесты зелёные | android-app / @capacitor-community/sqlite |
| M62 | Планшет/встраиваемый клиент «нет связи» с сервером, а по curl всё отвечает | CORS / прод-env / WebView-origin |
| M63 | CSS-правило с `display: none` не срабатывает по классу — узел размечен инлайновым `style` | renderer / планшетный хром |
| M64 | Выдвижная панель (`position: fixed` + `transform`) на старте «выезжает» с экрана, а контекст-меню внутри неё клипается | renderer / drawer / transform |
| M65 | Массовая серия POST спорадически ловит `HTTP 502` на случайной позиции, в логах приложения пусто | nginx / Node keep-alive |
| M66 | Список/каталог «не грузится» ТОЛЬКО на Android-планшете (на десктопе тот же код работает) | android / SQLite bind-лимит |
| M67 | Клик по пункту UI гасит ВЕСЬ экран: `#root` пустеет, в консоли «A component suspended while responding to synchronous input» | React / lazy + Suspense |
| M69 | Идемпотентный скрипт при повторном прогоне ПЛОДИТ дубликаты вместо пропуска | скрипты / генерация данных |
| M70 | Массовый серверный скрипт «зависает» без единого активного запроса в `pg_stat_activity` | скрипты / ledger-лок |
| M71 | Клиент перестал получать ЛЮБЫЕ изменения: курсор pull'а встал | sync / курсор |
| M72 | `fullPull` не лечит реплику: UNIQUE-конфликт живой старой строки с приезжающей | sync / реплика |
| M73 | После `git pull` на проде `tsc` оставил старый `dist` — рестарт поднял прежний код | прод / деплой |
| M74 | Планшет: первый полный pull детерминированно убивает приложение, часть таблиц пуста | android / bridge OOM |
| M75 | Нейросеть «всегда ошибка», а токены у провайдера не тратятся — отвергнутый запрос, не ключ | ai / llm |
| M76 | Кнопку не видно только на планшете: hover-only `opacity: 0` | ui / touch |
| M77 | Короткая метка из «хвоста номера договора» схлопывает все ГОЗ-договоры заказчика в одну | отчёты / номера договоров |
| M78 | Вкладка карточки переключилась, а прежняя панель осталась на экране (`hidden` не гасит) | ui / вкладки карточек |
| M79 | Массовая запись EAV ползёт ~1 сущность/мин и падает `std::bad_alloc` | server-script / ledger |
| M80 | Сгенерированный `.docx` «испорчен» в Word 2007 при валидном zip | office-экспорт / docx |
| M81 | Go-клиент падает `TLS handshake timeout` при живом сервере (DPI душит рукопожатие) | сеть / обновления |
| M82 | Литеральные управляющие символы и `\uXXXX` не выживают в исходнике при правке инструментами | инструменты / исходники |
| M87 | Ночной бэкап падает `UNIQUE constraint failed` и не создаётся вовсе — после одного оборванного прогона | бэкап / SQLite |
| M88 | Вложения двигателя видны в карточке, но скачивание отдаёт 403 — после фильтра `isNull(attributeDefs.deletedAt)` | EAV / доступ к файлам |
| M89 | Причесали подписи в отчёте — подытоги схлопнулись в одну строку | отчёты / группировка |
| M90 | Действие из панели МЕНЮ сработало «не от того» состояния: keep-alive вкладка держит стейл-колбэки | оболочка v3 / React |
| M91 | `vitest run` висит без единой строки вывода, процесс `node` жжёт 100 % CPU | local / тесты |

---

## M1 — SSH-таймаут к проду
- **Симптом:** `ssh matricarmz` → `Connection timed out` или `banner exchange`, при этом `ping` хоста отвечает мгновенно.
- **Корень (по частоте):** (1) неверный порт — хостер форвардит **внешний** порт на **внутренний** sshd (коннект на внутренний извне = таймаут; значения только в `~/.ssh/config`, в репо их нет); (2) нет `IdentitiesOnly yes` → ssh перебирает все ключи → fail2ban банит IP (тогда даже верный порт TCP-filtered).
- **Диагностика → лечение:** проверять в порядке **порт → ключ/`IdentitiesOnly` → fail2ban**. `~/.ssh/config` блок `Host matricarmz`: `Port <внешний>` + `IdentitiesOnly yes` + dedicated key. Бан снимается в консоли панели хостера (`fail2ban-client unban <IP>`). **Не долбить** логином при ошибке. Всегда `-o ConnectTimeout=15`. Транзиентный TCP-таймаут (после успешных вызовов) — одна повторная попытка, не цикл.

## M2 — better-sqlite3 ABI mismatch в локальных тестах
- **Симптом:** `corepack pnpm -F @matricarmz/electron-app test` роняет тесты, грузящие `new Database()`, с `NODE_MODULE_VERSION 145 vs 137`.
- **Корень:** нативный `better-sqlite3` собран под другую версию Node, чем у локального раннера. Окружение машины, **не баг кода**. В CI не воспроизводится (нативка пересобирается).
- **Лечение:** `pnpm rebuild better-sqlite3` (или переустановка) на этой машине.

## M3 — ложный TS2305 на @matricarmz/shared
- **Симптом:** `corepack pnpm -r typecheck` выдаёт `TS2305` (нет экспорта) на `@matricarmz/shared`, хотя экспорт есть.
- **Корень:** гонка пересборки `shared/dist` — параллельные пакеты тайпчекаются против полу-собранного dist.
- **Лечение:** гонять typecheck **по пакетам последовательно**, не `-r` разом.

## M4 — ложный exit 1 у dev:seed-fixtures
- **Симптом:** `corepack pnpm -F @matricarmz/backend-api dev:seed-fixtures` через PowerShell отдаёт `exit 1`, хотя сев прошёл.
- **Корень:** артефакт — `console.warn` пишет в stderr, PowerShell трактует непустой stderr как фейл.
- **Лечение:** запускать через `cmd /c "... > log 2>&1"` и смотреть лог, не код возврата.

## M5 — gh release download пропускает .blockmap
- **Симптом:** после релиза в `/opt/matricarmz/updates/` нет `*.blockmap`, delta/updater деградирует.
- **Корень:** мульти-`--pattern` в одном `gh release download` иногда не тянет `.blockmap`.
- **Лечение:** качать `.blockmap` **отдельным** `--pattern '*.blockmap'` (см. `AGENTS.md` §Release process — скачивать все три артефакта).

## M6 — серверный скрипт пишет в sync-таблицу, но клиент не получает
- **Симптом:** maintenance-скрипт изменил данные на проде, но клиенты не видят их при инкрементальном `/sync`.
- **Корень:** запись в обход `recordSyncChanges` не получает `last_server_seq` → `pullChangesSince` её не отдаёт. Плюс: presence-FK актора (нужен реальный employee) и stale-seq guard (`allowSyncConflicts`).
- **Лечение:** писать через ledger-путь (`recordSyncChanges`/`insertChangeLog`); в скрипте — реальный employee-актор + `allowSyncConflicts`. См. memory `server_script_sync_write_gotchas`.
- **Подтверждено + усилено 2026-06-18 (#6 WS-A2):** с актором `system` (НЕ реальный employee) `recordSyncChanges` **тихо проецирует 0 строк в PG** (`writeSyncChanges` → `applyPushBatch` `dbApplied=0, skipped=[]`), НО Step-1/3 (ledger sign+append + `ledger_tx_index`) **всё равно отрабатывают** → дрифт: ledger/index держат новое значение со свежим seq, PG — старое с `last_server_seq=null`. Инкрементальный pull (читает PG `last_server_seq>since`) НЕ отдаёт (seq null), а cold/`replayLedgerToDb` — отдаст → split-brain. **Сигнатура:** скрипт рапортует «применено N», но re-dry-run показывает те же N; `ledger_tx_index` для row_id имеет свежий seq, а PG `last_server_seq=null`/значение старое. **Грепай M6 ДО починки.** **Восстановление-вперёд:** `UPDATE … SET col, last_server_seq FROM (ledger_tx_index latest per row_id)` — проекция ledger→PG без нового append (учти глобально-уникальные индексы + intra-batch дубли). Либо повторить запись с **реальным employee-актором**.

## M7 — прод-конфиг «забит нулями»
- **Симптом:** странные отказы сервисов/sshd/nginx на прод-VPS без видимой причины.
- **Корень:** у хостера системные конфиги периодически забиваются нулями (баг хостинга).
- **Диагностика:** `file <path>` (покажет `data`/нулевой размер вместо текста). См. memory `prod_config_corruption`.

## M8 — setEntityAttribute не долетает инкрементально
- **Симптом:** атрибут, записанный через `setEntityAttribute` (напр. `department_id`), не приходит клиенту инкрементальным pull — только после полного `sync.fullPull`.
- **Корень:** часть EAV-записей вне ledger-delta → incremental не несёт их.
- **Лечение:** если поле должно доезжать инкрементально — провести через sync-путь; иначе помнить, что нужен fullPull (актуально для seed/fixtures verify).

## M9 — /updates/status через secondary отдаёт старую версию
- **Симптом:** после деплоя `/updates/status` (через secondary) показывает прошлую версию или `infoHash:null`.
- **Корень:** `updateTorrentService` читает updates-dir в in-memory state **при старте** и пере-сканит редко. Рестарт при старом installer в dir → старое состояние до следующего скана.
- **Лечение:** готовить **все** артефакты updater'а (`*.exe`/`latest.yml`/`*.blockmap` + `ledger-publish`) **до** рестарта (см. `AGENTS.md` §Release «Why download + ledger-publish go before restart»). Транзиентный `stale_manifest` на старте secondary самолечится интервал-сканом.
- **Вариант «устойчивый 404 + `lastError: stale_manifest`» (релиз v2026.715.1549, 2026-07-15):** `/updates/file/<exe>` и `<exe>.blockmap` дают **404 стабильно** (не разово), при этом `/health` и `/updates/status` рапортуют **новую** версию, а все три артефакта на диске и `latest.json` совпадает с `.exe` по `version`/`fileName`/`size`. Признак-отличие: в `/updates/status` — `"lastError":"stale_manifest"`, `"infoHash":null`, `"latestSource":"disk-fallback"`. **Корень:** `refreshState` при несовпадении манифеста с installer'ом ставит `currentState = null` ([updateTorrentService.ts](../backend-api/src/services/updateTorrentService.ts) ~337), а `/file/:name` без `st.filePath` отдаёт 404 — то есть версия в статусе приходит из disk-fallback (читает сам `.exe`), а раздача файлов мертва. Скан при старте поймал окно, когда новый `.exe` уже лежал, а `latest.json` был ещё от прошлого релиза (сверь `date -d @<lastScanAt>` с `stat -c '%y' latest.json` — mtime манифеста будет **позже** скана). Порядок из AGENTS.md соблюдён и всё равно ловится: сервис может стартовать между download и `ledger-publish` (напр. systemd поднял его после перезаписи `dist/` серверным build'ом). **Лечение:** ещё один `systemctl restart` обоих бэкендов → рескан читает финальный манифест → `lastError:null`, `infoHash` заполнен, `/file/` = 200. **Проверять `/updates/file/<exe>.blockmap` = 200 обязательно** — `/health` + `/updates/status` зелёные при мёртвой раздаче (клиенты теряют дельту: ~136 МБ вместо ~10 МБ).
- **Вариант (verify-шаг релиза, 2026-06-28):** сразу после рестарта `curl https://.../updates/file/<exe>.blockmap` может разово отдать **404**, хотя файл на диске и **оба** бэкенда (`:3001`/`:3002`) напрямую отдают его `200`. Корень тот же — один инстанс ещё не дочитал updates-dir в in-memory state на момент того запроса (nginx least_conn попал на него). **Не паниковать, не пере-выкатывать:** повторить через несколько секунд (`curl … x5`) → `200`. «Реальное» отсутствие blockmap (M18) отличается тем, что файл на диске отсутствует и бэкенд напрямую тоже даёт 404.

## M10 — drizzle-kit generate уходит в интерактив про чужие таблицы
- **Симптом:** добавил пару таблиц в `schema.ts`, `corepack pnpm -F backend-api db:generate` встаёт на интерактивном «Is X table created or renamed from another table?» про таблицы, которых ты не трогал (напр. `ai_chat_history`). В headless/agent-сессии = тупик.
- **Корень:** `drizzle/meta/*_snapshot.json` дрейфанул от схемы (прежние миграции заводились мимо `generate`). `generate` диффит схему против устаревшего snapshot → видит «новые» чужие таблицы → спрашивает rename-vs-create. Это **не** про твою правку.
- **Лечение:** не чинить snapshot ради одной миграции. Завести миграцию **вручную**: (1) правка `schema.ts` для рантайма; (2) написать `drizzle/NNNN_<name>.sql` (CREATE/ALTER + идемпотентный seed через `ON CONFLICT DO NOTHING`, разделители `--> statement-breakpoint`); (3) дописать entry в `drizzle/meta/_journal.json` (`idx`,`version:"7"`,`when`,`tag`,`breakpoints:true`). `db:migrate` (node-postgres migrator) применяет по **journal+sql, snapshot ему не нужен**. Так заведены 0062/0063 (Т-13). Починка snapshot'а — отдельная задача. Кросс-проектно: `to-brain/2026-06-17-drizzle-handwrite-migration-on-snapshot-drift.md`.

## M11 — печать: галка секции не показывает секцию / пустой лист
- **Симптом:** в окне печати (`openPrintPreview`) поставил/снял галку секции, а секция не появляется (изначально-скрытая остаётся скрытой). Классика: снял «Месяц целиком» → на печать выходит **пустой лист**, даже если отмечены другие секции.
- **Корень:** окно печати открывается `window.open('','_blank')` + `w.document.write(html)`. Inline `<script>` в **document.write-документе НЕ исполняется** в Electron-child-window → `applyVis` ни разу не запускается. Видимость держалась на JS + стартовом inline `style="display:none"`; а CSS `body:has(input:not(:checked))` умеет только **прятать** (`display:none !important`) и не может перебить inline `display:none` → checked-секция залипает скрытой.
- **Лечение:** не ставить inline `display:none` на изначально-невыбранные секции — видимость целиком на CSS `:has(:not(:checked))` (он реактивно и прячет, и показывает по `:checked`, без JS). JS-`applyVis` оставить как прогрессив-энхансмент. Файл `electron-app/src/renderer/src/ui/utils/printPreview.ts`. Кросс-проектный урок (любое Electron-приложение с print-preview через `window.open`+`document.write`): `to-brain/2026-06-18-electron-print-window-script-no-run.md`.

## M12 — глобальный unique-индекс считает soft-deleted строки → dedupe/cold-rebuild коллизия
- **Симптом:** (1) модуль «Дубли деталей»: «у главной детали нет складской карточки (номенклатуры)…» при слиянии пары с одинаковым кодом; (2) полный `replayLedgerToDb`/cold-rebuild падает на `duplicate key` по `code`, хотя в живом PG всё уникально.
- **Корень:** `uniqueIndex(...).on(code)` **без** `WHERE deleted_at IS NULL` считает и soft-deleted строки. Dedupe-merge soft-delet'ит loser, но он **продолжает занимать код** → нельзя создать/переуказать карточку выжившему; а replay апсёртит `includeDeleted` строки → два claim'а одного кода → коллизия. (Был `erp_nomenclature_code_uq`.)
- **Диагностика:** `pg_get_indexdef(<idx>)` — есть ли хвост `WHERE (deleted_at IS NULL)`; ledger-состояние через read-only `queryState('<table>', {includeDeleted:true})` — искать дубль `code` среди active+deleted (он же — orphan-мина для cold-rebuild).
- **Лечение:** identity-unique сделать **partial** `WHERE deleted_at IS NULL` (как `directory_workshops_code_uq` / `warehouse_locations_code_uq` / `users_username_uq` — выбивавшийся `erp_nomenclature_code_uq` приведён к конвенции). Миграция: `DROP INDEX` + `CREATE UNIQUE INDEX … WHERE "deleted_at" IS NULL` (safe, если нет двух **active** дублей). Безопасно создавать пока действует старый global-unique. Соседний фикс — heal в merge (создать карточку выжившему). Миграция `0066`/PR #492. Кросс-проектный урок (любой soft-delete + identity-unique + dedupe/replay): `to-brain/2026-06-19-soft-delete-unique-index-dedupe-trap.md`.

## M13 — dev: правки кода «не срабатывают» (молчаливый no-op) — устаревший backend на :3001
- **Симптом:** изменил роут/сервис, перезапустил стек, но эндпойнт ведёт себя по-старому (напр. новый query-параметр не пишет в БД, ошибки в логе нет). При этом прямой вызов функции через `tsx` и юнит-тест работают — значит код верный.
- **Корень:** `stop.ps1` верификатора **не всегда убивает** backend на :3001; `start-backend.ps1`, увидев занятый порт, не поднимает новый процесс → продолжает отвечать **старый** инстанс, запущенный до правки кода (`tsx` подхватывает исходники только при старте процесса). Лог `backend.log` показывает **старый** boot-timestamp — главная улика.
- **Диагностика:** `tr -d '\000' < .verifier-electron/backend.log | grep 'listening on'` — сверить boot-ts с моментом правки; если backend стартовал раньше правки — он устаревший.
- **Лечение:** принудительно убить по порту и поднять заново: `Get-NetTCPConnection -LocalPort 3001 -State Listen | Select -Expand OwningProcess -Unique | %{ Stop-Process -Id $_ -Force }`, дождаться `(Get-NetTCPConnection -LocalPort 3001).Count == 0`, затем `start-backend.ps1`. Не доверять `stop.ps1` вслепую при «код не срабатывает».

## M14 — outcome-телеметрия апдейтера не выстреливает на релизе, который её ввёл
- **Симптом:** раскатали релиз, добавивший телеметрию исхода обновления (`update-applied method=delta|full` → критсобытие `client.update.full_download` на full). После раската в критсобытиях **0** `client.update.full_download` и в серверных client-логах **0** `update-applied` — выглядит как «дельта/телеметрия сломана». Ложная тревога.
- **Корень:** `update-applied` шлёт **новый** клиент после рестарта (`reportPendingUpdateTelemetry`), но только если **исходный** клиент перед рестартом записал outcome-файл (`recordUpdateOutcome`). Оба символа introduced одним коммитом (#516, единственный тег — `v2026.621.1133`). Значит обновление *на* эту версию исходным клиентом, у которого `recordUpdateOutcome` ещё нет, телеметрию **не пишет**. Первый возможный заброс — на **СЛЕДУЮЩЕМ** релизе (источник = версия с `recordUpdateOutcome`). Плюс предусловие: операторы должны сперва доехать до этой версии (проверка — `SELECT last_version, count(*) FROM client_settings GROUP BY 1`).
- **Подтверждение дельты в поле (на следующем релизе):** позитив = `update-applied method=delta` в серверных `…/backend-api/logs/client-YYYY-MM-DD.log` (warn-строки доезжают через `/logs/client`); негатив = критсобытия `client.update.full_download`. ⚠️ **Тишина сама по себе двусмысленна** (либо дельта сработала, либо телеметрия не выстрелила) → критерий успеха = **наличие `method=delta` строк** + отсутствие `full_download`, не одна тишина. Файл критсобытий на проде: `…/backend-api/logs/critical-events.ndjson`.

## M15 — standalone-скрипт, пишущий в ledger, конфликтует/затирает живой ledger
- **Симптом:** ad-hoc maintenance-скрипт зовёт `setEmployeeAuth` (или иную sync-write-функцию) из отдельного `node`-процесса, параллельно живому backend → лог `source: 'empty_recovery'` + `Error: sync_conflict: attribute_values (1)`. Часть записей применилась, часть упала. В `ledger/index.json` появляется `lastSeq: 1` (пустой ledger).
- **Корень (двойной):** (1) **каталог ledger зависит от cwd** — `DEFAULT_LEDGER_DIR = resolve(process.cwd(), 'ledger')`. Скрипт из корня репо берёт `~/MatricaRMZ/ledger` (побочный/пустой → `empty_recovery` создаёт block #1), а живой backend (cwd=`backend-api`) использует `backend-api/ledger`. (2) **два писателя ledger одновременно** — скрипт и backend независимо назначают server-seq из общего state → `sync_conflict`. В худшем случае скрипт затирает state.json/index.json настоящего ledger пустым.
- **Диагностика:** `cat backend-api/ledger/index.json` (lastSeq — настоящий ~700k+) vs репо-корневой `ledger/index.json` (затёртый lastSeq 1); `psql -tAc 'SELECT count(*),max(server_seq) FROM ledger_tx_index'` — настоящее состояние в PG (источник истины, ledger-blocks восстановимы из него).
- **Лечение (M6-safe bulk-write):** писать в sync-таблицы только когда backend — **единственный** писатель. Скрипт: (а) запускать **из `backend-api`** (правильный ledger-каталог); (б) **остановить backend** перед запуском (`systemctl stop` обоих — sole writer); (в) **HARD-GUARD в скрипте**: прочитать `getLedgerLastSeq()`, и если seq не настоящий (< ~700000) — `process.exit` ДО любой записи (защита от затирания); (г) `setEmployeeAuth` поштучно; (д) поднять backend (перечитает обновлённый ledger). Альтернатива без скрипта — суперадмин через UI (идёт через живой backend). Затёртый побочный `~/MatricaRMZ/ledger` можно удалить (backend его не использует). См. также M6.

## M16 — `corepack pnpm install` на проде висит (electron-postinstall / сетевой стойл fetch)
- **Симптом:** при прод-деплое `corepack pnpm install` не завершается — виснет либо на `added N-1/N` (напр. 877/878), либо в `ps` зомби-`corepack pnpm install` с огромным etimes (часы/дни). Несколько параллельных деплоев усугубляют.
- **Корень:** два независимых стопора. (1) **electron-app postinstall** — нефильтрованный install ставит все 6 workspace'ов, `electron-app` качает electron-бинарь (~100MB, на Linux-проде **бесполезен** — `.exe` собирается в CI). (2) **Сетевой стойл fetch** — pnpm застревает на HTTPS-запросе к npm-CDN: соединение `ESTABLISHED`, данные не идут, эффективного таймаута нет → install зависает на `added N-1/N` (напр. 877/878) без активного build-процесса. Диагностика стойла: `ss -tnp | grep node` показывает застрявший `ESTAB … :443` у pnpm-pid; `ps -o wchan` = `ep_poll`; дочерних node-gyp/prebuild процессов НЕТ (не строит — ждёт сеть). Флаки-сеть VPS↔GitHub/CDN. Несколько параллельных деплоев + зомби усугубляют.
- **Лечение:** **code-only** релиз (lockfile «Already up to date») — пропустить install, собрать только серверные: `corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build`. **Install реально нужен** (lockfile менялся — напр. бампнут натив-dep у backend) — гнать с env-флагами: `env ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_fetch_timeout=45000 npm_config_fetch_retries=10 corepack pnpm install` (пропуск бесполезного electron-бинаря + короткий таймаут → застрявший fetch отваливается за 45с и переповторяется, пробивает флаки-сеть; выучено 2026-07-05: голый install висел бесконечно на 877/878, с флагами прошёл за 15с). Зомби/застрявшие install'ы убивать **по PID** (`ps`→`kill -9 <pid>`), НЕ `pkill -f 'corepack pnpm install'` — паттерн **самоматчит твою же ssh-команду** (в ней та же строка) и убьёт шелл до запуска. `dist/index.js`-сервисы не трогать. Релиз сериализовать (не внахлёст).

## M17 — кнопка в UI есть, но серверный ledger-гейт режет запись (UI ↔ server parity)
- **Симптом:** оператор видит кнопку «Добавить/редактировать», правит и локально сохраняется, но изменения не доезжают на сервер; в критсобытиях (`backend-api/logs/critical-events.ndjson`) — `server.authz.denied` `forbidden:<entityType>`, оффлайн-очередь синка ретраит бесконечно (шум каждые ~2 мин).
- **Корень:** авторизация в ДВА независимых слоя. (1) UI-гейт — `deriveUiCaps` → `caps.*` в `App.tsx` решает, показать ли кнопку. (2) Серверный ledger write-гейт — `shared/src/domain/ledgerAuthz.ts` `ENTITY_TYPE_REQUIREMENT` (резолвится в `partitionLedgerInputsByAuthz`) решает, принять ли sync-запись. Если они на РАЗНЫХ правах — кнопка показана, а запись режется. Частный случай: тип помечен `kind:'admin'`/`'superadmin'` → `operatorMeetsRequirement` для operator-ролей ВСЕГДА `false`, сколько ни выдавай permission-оверрайдов.
- **Диагностика:** взять `<type>` из `forbidden:<type>` → грепнуть в `ledgerAuthz.ts ENTITY_TYPE_REQUIREMENT` → сверить требуемое право с UI-гейтом этой кнопки (`App.tsx` `caps.*` → какой permission в `deriveUiCaps`). Расхождение = баг.
- **Лечение:** гейтить UI-кнопку И серверный ledger-write на ОДНО право. Правка политики — `ledgerAuthz.ts` (+ `ledgerAuthz.test.ts`). Нужно новое право — добавить в `PermissionCode` + `PERMISSION_CATALOG` (`shared/permissions.ts`) и протянуть в `deriveUiCaps` (`canEditX = has(perms,'x')`). Раскат серверной части и клиента **координировать**: деплой сервера со строгим гейтом ДО клиента с новой кнопкой-гейтом = тот же рассинхрон наоборот; выдать новое право пользователям до/в момент деплоя. Инцидент 2026-06-23 (contract/customer: UI на `masterdata.edit`, сервер на `admin` → #557 хотфикс → #558 выделенное `contracts.edit`).

## M18 — `gh release download` молча недокачивает артефакт (.blockmap) на прод-деплое
- **Симптом:** команда из AGENTS.md §Release шаг 7 `gh release download vX.Y.Z --pattern "*.exe" --pattern "latest.yml" --pattern "*.blockmap" -D /opt/matricarmz/updates --clobber` приехала **без `.blockmap`** (в каталоге только `.exe` + `latest.yml`), хотя в GitHub-релизе blockmap есть. Вывод команды пустой, ошибки нет. **Воспроизводится стабильно:** пропущен на v2026.624.49, v2026.624.1021 и v2026.624.1153 (сработал лишь на 623) — считать ожидаемым поведением multi-pattern, не «иногда».
- **Следствие:** без `<exe>.blockmap` на сервере роут `/updates/file/<exe>.blockmap` отдаёт 404 → клиентский blockmap-delta не включается → **все клиенты качают полный installer (~116 МБ) вместо дельты (~10 МБ)**. Тихая регрессия дельты на весь релиз.
- **Лечение:** **качать `.blockmap` отдельным `gh release download` вызовом** (AGENTS.md §Release шаг 7 уже разнесён на два вызова) — multi-pattern его роняет. После download всегда сверять наличие всех 3 файлов (`ls /opt/matricarmz/updates/ | grep <version>` → ждём `.exe`, `.exe.blockmap`, `latest.yml`); докачивать ДО рестарта — сервер подхватывает blockmap при пересканировании каталога на рестарте (in-memory `updateTorrentService`). Проверка после рестарта: `curl -fsSkI .../updates/file/<exe>.blockmap` → `200` + `Accept-Ranges: bytes`. Инциденты 2026-06-24 (v2026.624.49/1021/1153). Общий принцип — brain pool #011 «верь содержимому ответа, не сигналу успеха» (exit 0 ≠ всё приехало; cross-link G88). Связано с дельта-засевом топлива (`PENDING_FOLLOWUPS` §хвосты релиза, M14).

## M19 — `git rm --cached` / `git pull` / `reset --hard` на проде грозит удалить ЖИВЫЕ данные (ledger внутри checkout'а)

- **Симптом:** при чистке репо (untrack/реклон/resync прод-checkout'а) `git status` показывает ledger-файлы (`backend-api/ledger/server-key.json`, `blocks/*.json`, `bootstrap.json`) как deleted; «безобидный» `git rm --cached` + последующий `git pull`/`reset --hard` на проде стирает их из рабочего дерева.
- **Корень:** прод-backend по умолчанию резолвит ledger в `cwd/ledger` (`DEFAULT_LEDGER_DIR = resolve(process.cwd(),'ledger')`, `ledgerService.ts`), а `cwd` = `WorkingDirectory` systemd-юнита = `…/MatricaRMZ/backend-api`. Если рантайм-каталог `backend-api/ledger/` оказался **закоммичен** (трекается), то это ОДНОВРЕМЕННО git-объект и живые данные. Любое удаление из git удаляет живой подписной ключ + ранние блоки → повреждение цепочки / потеря ключа.
- **Диагностика:** `systemctl cat <svc> | grep WorkingDirectory`; `git ls-files backend-api/ledger | wc -l` (>0 = трекается — опасно); сверь `sha256sum` живого `server-key.json` с `git show HEAD:…/server-key.json` (совпало = прод использует закоммиченный ключ).
- **Лечение:** до любых git-операций — **relocate live-ledger ВНЕ checkout'а** (`MATRICA_LEDGER_DIR=~/matricarmz-ledger` в `/etc/matricarmz/matricarmz.env`, `mv` каталога при остановленных сервисах — rename атомарен в пределах ФС) + бэкап ключей. После relocate `backend-api/ledger` gitignored и пуст в checkout'е → `git reset --hard`/`pull` уже безопасны. Инцидент 2026-06-26 (H8): закоммиченный ledger в публичном репо (ключ + ПДн); см. `SECURITY.md` §инварианты, `PENDING_FOLLOWUPS` §Security.

## M20 — `/updates/status` показывает `stale_manifest`/старую версию после `ledger-publish` (до рестарта)
- **Симптом:** на прод-деплое после `corepack pnpm release:ledger-publish X.Y.Z` (шаг 8, ДО рестарта) `/updates/status` / `latest.json` отдают **предыдущую** версию, `lastError:"stale_manifest"`, `latestSource:"disk-fallback"`, `infoHash:null` или чужой; первый `ledger-publish` иногда пишет **частичный** `latest.torrent` (~2 КБ вместо ~18 КБ). Второй `ledger-publish` подряд однажды упал `ELIFECYCLE exit 1` (транзиент).
- **Корень:** работающий (ещё старый) backend держит состояние апдейтера **в памяти с момента старта** и периодически перегенерирует `latest.json`/`latest.torrent` из in-memory-состояния → затирает то, что записал `ledger-publish`, пока процесс не перезапущен. Первый publish мог записаться в момент этой перегенерации → частичный/устаревший манифест.
- **Диагностика:** после publish `cat /opt/matricarmz/updates/latest.json` — версия/`infoHash`/`torrentFile`; `ls -la latest.torrent` (размер ~18 КБ = полный). Расхождение с целевой версией → манифест затёрт живым процессом.
- **Лечение:** **порядок из AGENTS.md держать** (download+publish ДО рестарта), но публиковать `ledger-publish` **дважды** и после — **обязательный рестарт**: новый backend читает финальные `latest.yml`/`latest.json` при старте и генерит корректный манифест. После рестарта сверять `/updates/status` (`lastError:null`, целевая версия, `infoHash` есть) + blockmap `200`. Не паниковать на 502 сразу после рестарта — backend поднимается ~13 с (health до этого пуст). Инциденты 2026-07-01 (релизы 843/941/1139/1325). Родственно M9 (dual-instance stale) / M18 (verify содержимого).
- **Ещё окно (2026-07-13, v2026.713.1017):** даже при правильном порядке, если рестарт запускать **сразу** после того как `ledger-publish` напечатал «published», запись `latest.torrent` для крупного installer (~135 МБ) ещё дописывается — mtime манифеста легла на **~26 с ПОЗЖЕ** старта сервиса → стартовый скан прочитал несогласованный манифест → `stale_manifest` + blockmap 404. Диагностика: `stat -c '%y' latest.torrent` vs `systemctl show -p ActiveEnterTimestamp` — если манифест новее старта, скан его не видел. Лечение — **второй рестарт** (манифест уже финализирован) ЛИБО перед рестартом дождаться, пока `latest.torrent` перестанет расти.

- **Окно самоизлечения (2026-07-19, v2026.719.1157) — НЕ чинить руками:** после штатного рестарта `https://127.0.0.1/updates/status` показал `lastError:"stale_manifest"`, `latestSource:"disk"`, а blockmap — **404**, при том что все три артефакта лежали на диске и `latest.yml` был корректен. Причина не в манифесте: `stale_manifest` ставится **только** в `loadStateFromDisk` — это ветка **secondary**; primary в это время ещё хешировал 136-МБ installer в `seedLatestInstaller` и не успел переписать `latest.json` (в нём оставался размер от прошлой генерации). nginx балансирует, поэтому один запрос через `https://127.0.0.1` легко попадает на пессимистичный secondary. Через ~3 минуты **без единого действия**: оба инстанса `lastError:null`, размер верный, `infoHash` есть, blockmap `200`, range `206`.
  - **Диагностика прежде лечения:** опрашивать инстансы **напрямую, мимо nginx** — `for p in 3001 3002; do curl -fsS http://127.0.0.1:$p/updates/status; done`. Расхождение primary/secondary = идёт пересидирование, а не поломка. Через nginx этого не видно.
  - **Чего НЕ делать:** сносить `latest.json`/`latest.torrent`, гнать второй `ledger-publish` или лишний рестарт в первые минуты — это «лечение» здорового, и оно перезапускает хеширование с нуля. Ждать до ~3 мин на 136 МБ, потом перепроверять по обоим портам.

## M21 — фикс записи EAV (`setEntityAttribute`) не помог двигателям: у них свой write-путь `setEngineAttribute`
- **Симптом:** починил «список не обновляется после правки карточки» в `setEntityAttribute` (справочники/сотрудники) — а у **двигателей** баг остался.
- **Корень:** в клиенте (electron main) **несколько независимых write-путей атрибутов**. `admin:entities:setAttr`/`employees:setAttr` → `entityService.setEntityAttribute`, но `engine:setAttr` → **`engineService.setEngineAttribute`** (отдельная функция, свой дубль-баг: поиск строки по `(entity,attr)` без `deletedAt IS NULL`/сортировки, `limit(1)` → правит произвольную из дублей). Фикс одной функции не покрывает остальные.
- **Диагностика:** от IPC-канала (preload `window.matrica.<x>.setAttr` → `invoke('<chan>')`) дойти до фактического обработчика (`ipc/register/*`) и функции записи; свериться, что ВСЕ пути атрибутов имеют «свежайшая активная строка + гашение дублей». Грепнуть `.update(attributeValues).set({ valueJson` по `electron-app/src/main/services/*`.
- **Лечение:** во всех write-путях EAV — выбирать активную (`isNull(deletedAt)`) строку `orderBy desc(updatedAt)`, обновлять новейшую, soft-delete прочие активные; read-запросы списков сортировать `asc(updatedAt)` (свежайшее побеждает при остаточных дублях). Сервер держать чистым (`GROUP BY entity,def HAVING count>1` = 0). Исправлено #15 (`setEntityAttribute`, v1325) + #16 (`setEngineAttribute`, v1437). Родственно M8 (EAV-инкремент).

## M22 — после релиза изоляции у ВСЕХ операторов пустые списки нарядов (данные удалены purge с клиента)
- **Симптом:** после релиза «изоляции» списки нарядов/сущностей пустые у всех операторов (или остались только чужие/только свои); у одних работает, у других — нет, зависит от того, кто последним синхронизировался на машине.
- **Корень:** серверная изоляция чтения на sync-границе + клиентский **purge** (`db.delete(operations)` — жёсткое удаление) удаляли строки из локального SQLite по роли синкающегося. При переходе на модель «полная база на клиенте + фильтр на отображении» удалённые данные **не возвращаются инкрементом** (only-forward), а фильтр прячет остаток → пустой список. Локальная база оказалась привязана к последнему синкавшемуся, а не к авторизованному.
- **Диагностика:** сервер держит все строки (`SELECT count(*)` по таблице)? Да → потеря локальная. `client_settings.last_version` — на какой версии клиент. Проверить, был ли purge-эндпойнт/клиентский delete в раскатанных версиях.
- **Лечение:** **никогда не удалять синканные строки из локального кэша ради разграничения** — разграничение делать фильтром отображения (shared-политика, по авторизованному пользователю), держа полную базу. Восстановление уже пострадавших клиентов — бродкаст `force_full_pull_v2` всем: `UPDATE client_settings SET sync_request_id=gen_random_uuid()::text, sync_request_type='force_full_pull_v2', sync_request_at=(extract(epoch from now())*1000)::bigint` (клиент при опросе делает полный pull; `if(fullPull)` → `clearLocalSyncTablesForFullPull` чистит локалку и перезаливает с сервера). Инцидент 2026-07-01 (изоляция закрытых нарядов, релизы 941/1024→1139). Урок переносим — письмо в brain (разворот #063).

## M23 — значение застряло в списке, хотя карточка правится и `setAttr` корректен (dual-source read)
- **Симптом:** в СПИСКЕ поле показывает старое значение, в КАРТОЧКЕ то же поле правится и сохраняется; ресинк и фикс дублей (M20/M21) не помогают; на сервере у сущности — одна строка атрибута, дублей нет. Затрагивает часть записей, а не все (у «свежих» сущностей работает).
- **Корень:** список и карточка читают/пишут **РАЗНЫЕ атрибуты** для одного логического поля. Пример: «Дата отгрузки» — карточка правит статус-дату `status_customer_sent_date`, а список/отчёт читали прямой EAV-атрибут `shipping_date`, **предпочитая его** (`explicit ?? status ?? …`). Прямой атрибут — замороженный импорт (пишется только миграцией, карточкой не трогается) → у импортированных записей он не пуст и навсегда перекрывает свежую правку карточки. Родня — `is_scrap` (OR с живым `status_rejected`).
- **Диагностика:** (1) найти, что реально пишет карточка (`saveAllAndClose`/`setAttr` — какой code) vs что читает список-сервис (`list*`/`report*`). Если коды разные — dual-source. (2) Замороженность подтвердить на проде: `SELECT max(updated_at) ... GROUP BY attribute_def` — legacy-атрибут имеет старый `max(updated_at)` (импорт-окно) и много строк. (3) Explore-свип остальных модулей на тот же паттерн (обычно локализован в кастомных сервисах вроде `engineService`, generic-EAV не страдает).
- **Лечение:** развернуть приоритет чтения — **основным сделать атрибут, который правит карточка**, legacy-атрибут оставить историч. фолбэком (`status ?? … ?? legacy`), **без мутации данных** (обратимо). Legacy-значения остаются для записей без свежей правки и «оживают» при первом же редактировании карточки. Инцидент 2026-07-01 (`2Ж03АТ0479`, #18/#19, v2026.701.1708). Централизуй резолвер, если таких read-путей несколько (у двигателей их два: `listEngines` + `resolveEngineShippingState`).

## M24 — `db:migrate` на проде падает `must be owner of table X` (ownership drift)
- **Симптом:** релизный `corepack pnpm -F @matricarmz/backend-api db:migrate` падает `error: must be owner of table <X>` (code 42501), хотя миграция локально проходила. Drizzle-мигратор атомарен — **вся пачка pending-миграций откатывается** (включая невиновные), состояние БД чистое.
- **Корень:** таблица `<X>` когда-то создавалась на проде **вручную под `postgres`** (psql-сессией суперпользователя), а не приложенческим юзером (`$PGUSER`) через мигратор → `ALTER TABLE`/`DROP` на неё требуют ownership, которого у приложенческого юзера нет. Локально не воспроизводится (dev-БД целиком создана одним юзером).
- **Диагностика:** `SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public' AND tableowner <> current_user;` — все таблицы должны принадлежать приложенческому юзеру.
- **Лечение:** `sudo -u postgres psql -d "$PGDATABASE" -c "ALTER TABLE <X> OWNER TO $PGUSER;"` (metadata-only, безопасно) → повторить `db:migrate`. Постоянный фикс. Инцидент 2026-07-02 (`ai_chat_history`, релиз v2026.702.1024, миграция 0072).

## M25 — upsert BOM падает «в варианте __kit_* отсутствуют обязательные типы», хотя правишь только base-строки
- **Симптом:** сохранение/скриптовый merge BOM падает `BOM не сохранен: в варианте «__kit_…» отсутствуют обязательные типы из глобальной схемы: ring`, хотя kit-варианты не трогались — добавлялись только строки base.
- **Корень:** `upsertWarehouseAssemblyBom` — **full-replace**: пересохраняет ВСЕ строки BOM и заново валидирует каждый `__kit_*`-вариант на полноту по глобальной схеме. Легаси-киты, сохранённые до ужесточения проверки (или до расширения required-набора схемы), сегодняшнюю валидацию не проходят → любое добавление строк через upsert блокируется чужим легаси-состоянием.
- **Диагностика:** `select variant_group, component_type, count(*) ... group by 1,2` по строкам BOM — видно, каких required-типов нет в конкретном ките.
- **Лечение:** для аддитивных импортов НЕ пересохранять весь BOM: точечные insert/update строк + явная ledger-подпись (payload как в сервисе) + `ensureNomenclatureBrandPart` per новая строка — киты не трогаются. Образец: `backend-api/src/scripts/importZamenaKrBomNorms.ts` (инцидент 2026-07-02, импорт «Замена при КР»). Чинить сами киты — отдельное осознанное действие владельца в UI.

## M26 — JSON-атрибут EAV записан с двойной кодировкой: читатели «случайно» работают, идемпотентность-проверка видит пусто
- **Симптом:** backfill-скрипт записал JSON-атрибут (напр. `section_access`) через `setEntityAttribute(actor, id, attr, JSON.stringify(obj))`; значения в БД есть, рантайм-читатели работают, но повторный dry-run того же скрипта показывает «уже настроено=0» и планирует засев заново.
- **Корень:** `setEntityAttribute` сам JSON.stringify'ит переданное значение → в `value_json` лежит **JSON-строка внутри JSON** (`"{\"production\":...}"`). Читатели, которые парсят дважды (внешний `JSON.parse` + tolerant-парсер, принимающий строку), работают «случайно»; кто парсит один раз — получает строку вместо объекта → `{}`.
- **Диагностика:** `select left(value_json,80) …` — значение начинается с `"{\"` (escaped кавычки) вместо `{"`.
- **Лечение:** tolerant-парсер уровня домена парсит **до двух уровней** строки (`parseSectionMembership`, PR #50); при записи новых JSON-атрибутов через `setEntityAttribute` — передавать объект/сырое значение согласно контракту функции, и всегда прогонять idempotency-повтор dry-run сразу после apply (ловит класс на месте). Инцидент 2026-07-03 (backfill section_access, релиз v2026.703.1049).

## M27 — nginx reload не перевешивает изменённый listen-адрес
- **Симптом:** в конфиге поменяли `listen 18080` → `listen 127.0.0.1:18080`, `nginx -t` ок, `nginx -s reload` прошёл, но `ss -tln` по-прежнему показывает `0.0.0.0:18080` (мастер-процесс держит старый сокет).
- **Корень:** reload у долгоживущего мастера не всегда пересоздаёт listen-сокеты при смене адреса привязки (мастер унаследовал старый fd).
- **Лечение:** `sudo systemctl restart nginx` (даунтайм <1с) → `ss -tln` показывает новый адрес. После любого изменения `listen`-строк проверять привязку через `ss`, не доверять успешному reload. Инцидент 2026-07-04 (security Фаза 2, #69).

## M28 — presence-хартбиты в durable-ledger → O(N²) CPU-амплификация синка
- **Симптом:** оба backend-инстанса держат ~50% CPU (главный JS-поток `R`, воркеры libuv простаивают), клиентов подвешивает, выкидывает в релогин, «обрывы с базой». В nginx-логе клиенты повторяют один и тот же `since` в `GET /ledger/state/changes` по 5-8 раз; запись в ledger мизерная, но CPU высокий → значит стоимость на **чтении/расшифровке**, не на записи.
- **Корень:** `user_presence` был полноценной sync-таблицей — каждый хартбит (`/presence/me` раз в 60с × каждый клиент, плюс `touchPresence` при отправке чата) писался строкой в зашифрованный append-only ledger через `recordSyncChanges`. Presence составлял ~⅔ всех записей ledger. Каждая запись двигала голову ledger → все клиенты постоянно перекачивали и **расшифровывали** перекрывающиеся окна `/ledger/state/changes` на главном потоке. При N клиентах — O(N²) крипто-работы.
- **Диагностика:** `psql` по `ledger_tx_index` — доля `table_name='user_presence'` в свежих строках (`where server_seq > max-600`); `top -H -b -p <pid>` (горит главный TID = сам процесс); nginx `matricarmz_access.log` — повтор `since` по client_id. presence живёт и так в таблице `userPresence` (сервер отдаёт онлайн-статус в chat/notes + self-ping `/presence/me`), клиент синканные presence-строки для UI **не читает** → ledger-фанаут был чистым дублем.
- **Лечение:** не писать presence в ledger — только в таблицу `userPresence`. Убрано в `routes/presence.ts` и `routes/chat.ts` (table-only), плюс защитный фильтр `user_presence` в `writeSyncChanges` (инвариант «presence не в ledger» для любого пути). Тест `presenceNotLedgered.test.ts`. Инцидент 2026-07-07, фикс #110 (`10022b3c`): presence-запись в ledger 9/мин→0, load 1.5→0.6. **Общий урок:** эфемерные высокочастотные данные (presence/heartbeat/typing) не кладём в durable-фанаут-ledger — отдельный лёгкий канал.

## M29 — `gh release download` оборвался по таймауту → `.exe` недокачан, но лежит «как скачанный»
- **Симптом:** `gh release download vX.Y.Z --pattern "*.exe" …` прервался (обёртка/таймаут), файл `.exe` на диске есть и без ошибки — но его размер **меньше**, чем в `latest.yml` (`size:`). Второй `--pattern` (blockmap) при обрыве первого вообще не выполнился. Если такой недокачанный `.exe` задеплоить, electron-updater отвергает обновление по **sha512-несовпадению** (в `latest.yml` хэш полного файла) → клиенты не обновляются.
- **Корень:** `.exe` инсталлятора большой (~130 МБ); при флаки-сети/жёстком таймауте команды скачивание обрывается на полпути, `gh` не всегда чистит частичный файл и rc может маскироваться обёрткой. Отдельная грабля от M18 (там multi-pattern роняет blockmap целиком) — здесь **сам основной файл усечён**.
- **Диагностика:** сверить размер с манифестом до деплоя — `stat -c '%s' <exe>` против `size:` в `latest.yml`; надёжнее — sha512: `openssl dgst -sha512 -binary <exe> | openssl base64 -A` == `sha512:` в `latest.yml`. Инцидент 2026-07-08 (релиз v2026.708.1553): первый download оборвался на 132014656 из 135433310 Б; поймано сверкой размеров до scp.
- **Лечение:** качать `.exe` **отдельным** вызовом с щедрым таймаутом (не в одной команде с blockmap), после скачивания **всегда сверять размер + sha512 с `latest.yml`** перед scp на прод; при несовпадении — `rm` и перекачать. Общий принцип — brain pool #011 «верь содержимому, не сигналу успеха» (rc 0 ≠ файл целый; ср. M18). Память [[prod_gh_release_download_tls_timeout]] (локальный download + scp) — дополнена: локальный download тоже может усечься.

## M30 — backend-скрипт на проде подписал sync-изменения «в никуда» (паразитный ledger, низкие seq)
- **Симптом:** прод-прогон `pnpm -F @matricarmz/backend-api <script>` с записью через `recordSyncChanges`/`writeSyncChanges` даёт `sync conflict rows skipped` на каждую строку; изменения ложатся в PG-таблицы, но клиенты их **никогда не получают** (инкрементальный pull их не видит). В `ledger_tx_index` появляются свежие строки с **аномально низкими** `server_seq` (напр. 49669 при живом максимуме ~815894).
- **Корень:** боевой `MATRICA_LEDGER_DIR=~/matricarmz-ledger` задан только в `/etc/matricarmz/matricarmz.env` (systemd `EnvironmentFile`), а `dotenv/config` скрипта грузит лишь `backend-api/.env`, где переменной нет → `resolveLedgerDir()` падает в дефолт (`backend-api/ledger` — древний брошенный каталог с lastSeq≈49k) → seq аллоцируются из его счётчика → `filterStaleBySeqOrUpdatedAt` видит `incomingSeq < currentSeq` и скипает PG-апдейт, а проекция в `ledger_tx_index` пишет мусор с низкими seq (клиентские курсоры давно дальше — строки невидимы).
- **Диагностика:** `select min(server_seq), max(server_seq) from ledger_tx_index where created_at > <время прогона>` — низкий min = паразитный ledger. Инцидент 2026-07-11 (`fix:owner-batch-20260710`, 3 прогона).
- **Лечение:** прод-прогоны backend-скриптов запускать **с сорсом боевого env**: `set -a; . /etc/matricarmz/matricarmz.env; set +a; corepack pnpm -F @matricarmz/backend-api <script>`. После инцидента: удалить мусорные низко-seq строки из `ledger_tx_index` (точечно по `created_at` прогона + `server_seq < живого диапазона`) и перегнать скрипт с правильным env (идемпотентные шаги должны уметь **репропагацию** при уже-корректных значениях). `db:migrate` этой граблей не страдает (не пишет ledger), но env всё равно сорсить.

## M31 — `recordSyncChanges` для ERP-таблиц молча НЕ пишет в PG (ledger подписан, строка не изменилась)
- **Симптом:** серверный скрипт пишет `erp_nomenclature` (или другую ERP-таблицу) через `recordSyncChanges`/`writeSyncChanges`, ошибок нет, ledger подписан, `ledger_tx_index` заполнен — а PG-строка **не изменилась**; скрипт рапортует успех.
- **Корень:** `writeSyncChanges` применяет PG через `applyPushBatch`, а у того ветки только для EAV/операций/чата/заметок — **ERP-таблиц там нет**, их строки тихо игнорируются (applied=0, даже в skipped не попадают). ERP-таблицы клиенты пушат другим путём; канонический серверный write — доменные функции (`upsertWarehouseNomenclature` и т.п.: прямой PG-upsert + `signAndAppendDetailed`).
- **Диагностика:** после «успешного» прогона перечитать строку из PG (`directory_kind`/`updated_at`) — не верить молчанию. Инцидент 2026-07-12 (первый apply `warehouse:link-nomenclature-to-part` по «Гильзе»).
- **Лечение:** для серверных правок ERP-таблиц звать канонический доменный upsert, не `recordSyncChanges`; в скриптах после apply — обязательный re-read PG с assert (паттерн `linkNomenclatureToPart.ts`). Ср. M30 (та же семья «сигнал успеха ≠ содержимое»; при непросорсенном env ledger вдобавок паразитный).

## M32 — сборочный наряд: двигатель шапки есть, а читатель видит пусто («строки vs шапка»)
- **Симптом:** у Assembly-наряда двигатель в шапке выбран, но зависимые данные пусты: №/марка в списке и печати, двигатель/заказчик в отчёте «Наряды», договор/заказчик в строке реквизитов печати; либо кнопка «Сохранить как черновик»/«Закрыть и провести» задизейблена с «укажите двигатель», хотя он выбран. Оператор лечит ритуалом **«убрать номер двигателя → сохранить → вернуть → сохранить»** — и это «помогает», маскируя корень.
- **Корень:** с #133 двигатель сборки живёт в **шапке** (`payload.assemblyEngineId`), а читатель ходит по построчным штампам `freeWorks[].engineId`. Строки бывают без штампа: пикер шапки штампует только **уже существующие** строки, а универсальный шаблон своего двигателя не несёт → `buildLinesFromWorkOrderTemplate` клал строки без `engineId`, после чего `normalizeWorkOrderLine` (поля двигателя вложены в `if (engineId)`) срезал у них номер и марку **навсегда**. Ритуал работает потому, что при повторном выборе строки уже есть и штамп по ним попадает — сохранение тут ни при чём.
- **Диагностика:** `payload.assemblyEngineId` заполнен, а `freeWorks[].engineId` — `null`/пусто (проверить через `workOrders.get(id)`). Провенанс: `select engine_entity_id from operations where id=…` → `00000000-0000-0000-0000-000000000002` (контейнер нарядов) вместо двигателя — значит читатель промахнулся. Симптом **молчаливый**: не ошибка, а пустая ячейка.
- **Лечение:** любой прод-читатель двигателя сборки — только **`resolveAssemblyEngineId`** (шапка → fallback на строки), **никогда** `primaryAssemblyEngineId` (только строки; помечен legacy, прод-вызовов не осталось) и никогда `freeWorks.find(l => l.engineId)`. Любой генератор строк наследует двигатель шапки (`addFreeWorkLine` / «Заполнить из спецификации» / шаблон). Рецидивировало **4 раза** посимптомно: #168 (список/печать №), #192 (отчёт), #224 (договор/заказчик в печати), #225 (корень: шаблон + `engine_entity_id` + гейты кнопок). ⚠️ Гейты кнопок нельзя ослаблять раньше `workOrderEngineEntityId` — иначе наряд с двигателем только в шапке сохранится с провенансом на изделие/контейнер.

## M33 — новое поле шапки складского документа молча теряется (цепочка из 6 точек)
- **Симптом:** добавил поле в шапку складского документа (напр. `engineId`/`workOrderId`), UI его показывает и «сохраняет» без ошибок — а после перезагрузки карточки поле пустое; либо доезжает до БД, но проведение его игнорирует (движение в регистре без него). Ошибок нигде нет.
- **Корень:** поле шапки проходит **шесть независимых точек**, и любая пропущенная режет молча: (1) `WarehouseDocumentHeaderPayload` + `WarehouseDocumentUpsertInput.header` в `shared/src/domain/warehouse.ts`; (2) zod-схема роута `POST /warehouse/documents` **и** её ручной pass-through блок `...(parsed.data.header.X !== undefined ? {X} : {})` (zod strip — поле не в схеме = его нет); (3) `HeaderPayloadInput` + `mergeHeaderPayloadJson` (запись в payload); (4) `parseWarehouseHeaderPayload` (чтение); (5) **оба** DTO-маппинга — список (`listWarehouseDocuments`) и карточка (`getWarehouseDocument`); (6) на клиенте — state + `load()` + **оба** тела `documentCreate` (`saveDocument` и `planDocument`) + dirty-снапшот `stockDocumentDirty.ts`. Отдельно: если поле должно попасть в **регистр**, его надо прокинуть в `planned.push({...})` нужной ветки `postWarehouseDocument` — ветки `stock_issue`/`stock_writeoff` исторически не передавали `engineId` (только `assembly_*`), т.е. «регистр уже готов» ≠ «регистр заполняется».
- **Диагностика:** round-trip через REST (`POST /warehouse/documents` → `GET /warehouse/documents/:id` → поле в `header`) — быстрее UI; если round-trip зелёный, а движение пустое — смотреть ветку docType в `postWarehouseDocument`. Симптом молчаливый: 400 не будет, zod просто отбрасывает лишнее.
- **Лечение:** при добавлении поля шапки пройти список выше как чек-лист (grep по соседнему полю `counterpartyId` даёт ровно все точки), затем смоук: create-with-field → get → post → `GET /warehouse/movements?documentHeaderId=…`. Та же семья, что `partspec_brandlink_zod_strip` (memory) — zod-strip + парные точки записи/чтения. Найдено при Ф3 плана `parts-movement-refactor-2026-07` (PR #257).

## M34 — мягкий гейт в `applyPushBatch` не держит: отклонённые строки воскресают
- **Симптом:** добавил в `applyPushBatch` мягкий отказ (строка → `skipped`, батч не падает). Живой пуш ведёт себя правильно, а после `replayLedgerToDb` / cold-rebuild отклонённые строки оказываются в PG, будто гейта не было.
- **Корень:** `applyPushBatch` — **проекция ledger'а в PG**, а не точка авторизации. К моменту вызова строка уже подписана и лежит в ledger (`signAndAppendDetailed` идёт раньше), поэтому любой replay применит её заново. Точка авторизации ровно одна — `partitionLedgerInputsByAuthz`, у неё единственный call-site `ledgerTxService.ts` (клиентский submit), и именно поэтому её не задевают ни replay, ни maintenance-скрипты.
- **Диагностика:** гейт «работает» в e2e, но `replayLedgerToDb` на копии БД возвращает отклонённое. Проверить, что решение принимается ДО ledger-append: строка не должна попадать в `signAndAppendDetailed`.
- **Лечение:** любые новые правила «эту запись клиенту нельзя» ставить в `partitionLedgerInputsByAuthz`, а не в `applyPushBatch`. Найдено при проектировании Ф2 advisory-резерва (`docs/plans/engine-reservation-f2-2026-07.md`), поэтому в коде гейт резерва сразу стоит в pre-ledger слое — вопреки букве родительского плана.

## M35 — advisory-резерв: гейт видит не всё, что кажется «правкой двигателя»
- **Симптом:** двигатель занят, а чужая правка всё равно применилась. Либо обратное: замок двигателиста молча зарубил наряд мастера / заявку снабженца / складское движение кладовщика.
- **Корень:** охват гейта ограничен намеренно — engine-entity, её `attribute_values` и операции **по белому списку типов** (`ENGINE_RESERVATION_GATED_OPERATION_TYPES`). `engine_entity_id` есть у ВСЕХ операций, включая `work_order`, `supply_request`, `stock_*`, `tool_movement` — их пишут роли, у которых нет ни плашки, ни кнопки резерва, и гейт по «есть engine_entity_id» блокировал бы чужие контуры без объяснения. Плюс правки смежных сущностей (детали ремфонда как самостоятельные записи, номенклатура, файлы) резервом НЕ покрыты вовсе. Отдельно: правки со штампом раньше `startedAt + 15 мин` проходят всегда (pre-lock grace для оффлайн-планшета), поэтому первые 15 минут после взятия замок не режет.
- **Диагностика:** посмотреть `reason` в `skipped` пуша — `reserved:<логин>:<expiresAt>` означает срабатывание гейта. Нет reason → либо тип операции вне белого списка, либо `updated_at` строки попал в grace, либо актор — admin/superadmin (они проходят всегда).
- **Лечение:** расширять список типов операций одной константой в `shared/src/domain/engineReservation.ts`, а не условием «есть engine_entity_id». Аварийный выключатель всего гейта — env `MATRICA_ENGINE_RESERVATION_GATE=off` на backend-сервисах.

## M36 — backstop по коду атрибута обходится подложным `attribute_defs` из того же батча
- **Симптом:** гейт `partitionLedgerInputsByAuthz` должен запрещать запись атрибута с защищённым кодом (`system_role`, `password_hash`, `engine_reservation`), тесты зелёные — а клиент значение всё-таки записывает.
- **Корень:** `codeByDefId` строился ТОЛЬКО из БД (`select(attributeDefs).where(inArray(id, …))`). Определение, приехавшее **в этом же батче**, в БД ещё не лежит → код резолвится в `null` → `isServerOnlyEmployeeAttr(entityTypeCode, null)` даёт `false`, и строка проходит. Клиенту достаточно в одном submit'е отправить `attribute_defs` со своим `id` и нужным `code`, а следом `attribute_values` по этому `id`. Ровно та же дыра, что уже была закрыта для сущностей (`typeIdByEntityId` подмешивает `entities` из батча) — для defs подмешивание забыли.
- **Диагностика:** отправить батч из двух строк (def + value) и посмотреть `skipped`. Если `reason` не пришёл — код атрибута не резолвится.
- **Лечение:** после DB-запроса дополнить `codeByDefId` определениями из самого батча (`inp.table === SyncTableName.AttributeDefs`), батчевое значение приоритетнее. Регресс-тест — `ledgerAuthzGuard.test.ts` «backstop не обходится подложным attribute_def из ТОГО ЖЕ батча». Найдено состязательным ревью Ф2 (PR #297); дыра существовала и для employee-auth backstop'а (security-hardening-2026-06 C2) — закрыта тем же фиксом.

## M37 — наряд с номером 0 (или «номер новый навсегда») после устаревшего recovery-черновика
- **Симптом:** в списке нарядов наряд с номером `0` либо с внезапно свежим номером (напр. 103 вместо своего 86); внутри карточка пустая — строки работ без услуги, суммы нулевые. У пострадавших нарядов в `audit_log` есть `work_order.create` с НОРМАЛЬНЫМ номером, а последующие записи уже с `0`.
- **Корень:** deferred-create. `createWorkOrder` не пишет строку в БД и возвращает payload с сентинелом `workOrderNumber: 0`; номер присваивается первым `updateWorkOrder` (`max+1`). Recovery-черновик карточки, снятый ДО материализации, несёт этот ноль (и пустое содержимое) — коммит такого черновика поверх живого наряда затирал и номер, и строки. Закрыто в PR #283 (v2026.719.2040): номер строки БД побеждает payload, ноль лечится свежим `max+1`. Но «лечится свежим» значит, что **старый номер не возвращается** — пострадавший наряд после первого же сохранения получает номер в конце нумерации, а его собственный номер остаётся дырой.
- **Диагностика:** `select id, (meta_json::jsonb->>'workOrderNumber') from operations where operation_type='work_order' and deleted_at is null and coalesce(nullif(meta_json::jsonb->>'workOrderNumber','')::numeric,0) <= 0;` — живые нули. Исходный номер поднимается из `audit_log`: `where entity_id = '<uuid>' and action = 'work_order.create'` (payload несёт `workOrderNumber`); второй источник — история строки в `ledger_tx_index` по `(table_name='operations', row_id)`.
- **Лечение:** не «сохранять» пострадавший наряд до починки — сохранение выдаст ему новый номер и след потеряется в ещё одну дыру. Чинить сменой номера суперадмином (кнопка `✎ №` в карточке → IPC `workOrders:setNumber`, номер проверяется на занятость) либо разовым скриптом `pnpm -F @matricarmz/backend-api fix:zero-wo-numbers-20260722 --apply`. Серверный backstop `workOrderNumberGuard` с 2026-07-22 лечит чужую смену номера обратно к сохранённому, поэтому источник нулей закрыт с обеих сторон.

## M38 — скрипт по `erp_*`-таблице «отработал», а в PG ничего не изменилось

- **Симптом:** maintenance-скрипт по `erp_nomenclature` (или другой `erp_*`) печатает `APPLIED: N`, ledger растёт, `ledger_tx_index` пополняется — а `select` в PG показывает старые значения, клиенты изменений не видят даже после `fullPull`. Вариант того же корня: скрипт падает `sync_invalid_row: erp_nomenclature` и не делает вообще ничего.
- **Корень:** `recordSyncChanges` → `writeSyncChanges` → `applyPushBatch`, а в `applyPushBatch` **нет веток ни для одной `erp_*`-таблицы** (обрабатываются только `entity_types`/`entities`/`attribute_defs`/`attribute_values`/`operations`/`audit_log`/`chat_*`/`notes`/`note_shares`/`card_drafts`/`ai_chat_requests`/`user_presence`). Путь подписывает ledger и молча ничего не приземляет. Клиенты же читают `erp_*` **из PG** (`pullChangesSince` + холодный снимок в `routes/ledger.ts`), поэтому изменение не появляется нигде. Второй слой: payload валидируется `erpNomenclatureRowSchema`, где `code: z.string().min(1)` — попытка записать пустой код (легальная конвенция «артикула нет») роняет прогон до любых мутаций.
- **Диагностика:** `grep -c erpNomenclature backend-api/src/services/sync/applyPushBatch.ts` → `0`. Если скрипт зовёт `recordSyncChanges` для `SyncTableName.Erp*` — этого достаточно, дальше можно не искать. Проверка по данным: `select code, updated_at from erp_nomenclature where id = '<uuid>'` до и после прогона.
- **Лечение:** писать канонически — прямой `UPDATE` в PG + `signAndAppendDetailed` (образец: `upsertWarehouseNomenclature`, `warehouseService.ts`). `recordSyncChanges` оставить EAV/operations-таблицам. Помни про доставку: `last_server_seq` для `erp_*` не проставляет никто, кроме `applyPushBatch`, поэтому даже корректная запись **не едет инкрементальным пуллом** — после серверной правки `erp_*` нужен force_full_pull клиентам (родственная M6, но там запись в БД доходила, а тут нет).
- **История:** урок выучен вживую 2026-07-12 (`linkNomenclatureToPart.ts`, попытка усыновить «Гильзу») и записан **комментарием в том файле** — в GOTCHAS не попал. В тот же день двумя соседними скриптами (`blankSyntheticCodes`, `reconcileNomenclatureDirectoryCodeName`) грабля была наступлена повторно и прожила до 2026-07-22; прогон `reconcile --apply` 12 июля, отчитавшийся «18 артикулов промоутнуто», по коду в PG не приземлился. Мораль: урок, оставленный комментарием в одном файле, не переносится — место ему здесь.

## M39 — правка «встала», а через полминуты откатилась (серверный backstop лечит её назад)

- **Симптом:** значение поменялось в карточке и в списке, всё выглядит сохранённым, а через ~30 секунд возвращается прежнее. Повтор даёт то же самое. Живой случай 2026-07-23: смена номера наряда суперадмином (кнопка `✎ №`) — №86 → №85 откатывался дважды.
- **Корень:** серверный field-level backstop **лечит** строку (переписывает поле на сохранённое) вместо отказа, а клиент подтягивает вылеченное значение ближайшим pull'ом — отсюда задержка в полминуты. Конкретно в `workOrderNumberGuard` осознанная смена опознаётся по маркеру в payload (`auditTrail`, `action='number_change'`), а `updateWorkOrder` собирал след аудита **из payload'а открытой карточки** — снимок сделан при загрузке, маркера в нём нет. Любое следующее сохранение карточки стирало маркер из строки, push уходил без него, и гейт лечил номер назад. Класс шире одного поля: **гейт по маркеру намерения ломается, если маркер живёт в данных, которые клиент перезаписывает целиком.**
- **Диагностика:** лечение всегда логируется — `ssh matricarmz "sudo journalctl -u matricarmz-backend-primary -u matricarmz-backend-secondary --since '1 day ago' --no-pager | grep -i 'healed'"`; строка несёт `stored` / `incoming` / `action`. Дальше смотреть, дошёл ли маркер: `select e->>'action', e->>'note' from operations o, json_array_elements(o.meta_json::json->'auditTrail') e where o.id='<uuid>'`. Если в следе только `update` — маркер потерян по дороге, а не отвергнут.
- **Лечение:** след аудита — история, а не поле карточки: базой брать то, что уже лежит в строке БД, и добавлять недостающее (`mergeAuditTrail` в `workOrderService.updateWorkOrder`), а не доверять копии от клиента. Парная страховка на сервере — принимать только **последний** маркер и только если он новее сохранённого, иначе вечно живущий в следе старый маркер даёт устаревшему клиенту откатить значение. Данные, уже испорченные откатами, чинить серверным скриптом (`fix:zero-wo-numbers-20260722 --apply`) — он пишет через `writeSyncChanges` мимо гейта.

## M40 — после релиза `stale_manifest` и blockmap 404 (манифест собран по недокачанному installer'у)

- **Симптом:** после раската `/updates/status` показывает нужную версию, но `lastError: "stale_manifest"`, а `curl /updates/file/<exe>.blockmap` → **404** при том, что файл на диске лежит и весит сколько надо. Клиенты в таком состоянии обновление не увидят.
- **Корень:** `updateTorrentService` сканирует каталог обновлений **раз в 60 с** (`RESCAN_INTERVAL_MS`) и по результату скана сидирует торрент и пишет `latest.json`. `gh release download` пишет `.exe` прямо в этот каталог, поэтому скан ловит файл **на середине загрузки**: и манифест, и торрент собираются по частичному размеру. Дальше рассинхрон ловит сверка `version/fileName/size` — расхождение обнуляет `currentState`, а роут `/updates/file/:name` резолвит путь **из состояния**, поэтому отдаёт 404 сразу для обоих файлов (и installer'а, и blockmap'а). Живые случаи 2026-07-23: v2026.723.1101 (манифест 8.7 МБ из 136, торрент 12 КБ вместо ~21 КБ) и v2026.723.1137 (59 МБ из 136); **2026-07-26 наступили в третий раз** — v2026.726.1033 (17.9 МБ из 136), потому что порядок ниже жил только здесь, а не в релизном чеклисте. После этого ожидание манифеста внесено в `AGENTS.md` §Release process шагом 8b — граблю чинит **процесс**, а не память.
- **Важно:** `release:ledger-publish` **не** переписывает манифест сам — он публикует релиз в ledger. Манифест чинит **следующий переcкан**, который видит новый размер и пересидирует. То есть состояние **само лечится в течение минуты** после того, как файл дописан; повторный `ledger-publish` в прошлый раз «помог» лишь потому, что между вызовами прошёл переcкан.
- **Диагностика:** `grep size /opt/matricarmz/updates/latest.json` против `ls -la` того же `.exe` (и против `gh release view vX.Y.Z --json assets`). Размер торрента подозрительно мал — то же самое другими словами.
- **Порядок, который не наступает на грабли:** скачать артефакты → **дождаться, пока размеры на диске совпадут с ассетами релиза** → дождаться, пока `latest.json` покажет тот же размер (≤60 с, ждать циклом, а не «на глаз») → `release:ledger-publish` → рестарт → проверить `lastError: null` и blockmap **200**. Рестарт до того, как манифест сошёлся, даёт ровно этот симптом.

## M41 — скрипт «отработал успешно», но задел почти не тронут (строки ушли в корзину-исключение)

- **Симптом:** массовый maintenance-скрипт по прод-данным печатает отчёт без ошибок и с ненулевым счётчиком, но реально обрабатывает единицы строк из сотен. Разница молча оседает в «мягкой» корзине вида SUSPICIOUS / SKIPPED / «не наша форма» — её печатают списком, а не считают отказом.
- **Живой случай 2026-07-23:** `warehouse:blank-synthetic-codes` на проде — `BLANK=4, SUSPICIOUS=141` при задаче в 145 строк. Маска `SYNTHETIC_STRICT` знала только текущую форму генератора (`PREFIX-<11 цифр>`), а 97% прод-данных были в **легаси-форме** `PREFIX-<8 hex>`, чьего генератора в коде уже нет. Прогон завершился бы с нулевым exit-кодом и рапортом «применено».
- **Корень (шире одного скрипта):** классификатор выводили из **текущего кода**, а данные накопила **вся история** приложения. Любой «распознаватель формы», построенный по живому генератору, слеп к строкам, которые породили его предшественники — а именно они и составляют массив легаси-данных, ради которого пишется скрипт.
- **Диагностика:** до `--apply` сверить сумму корзин с реальным размером задела **в БД** (`select count(*) … where <широкий предикат>`), а не с тем, сколько скрипт назвал кандидатами. Расхождение = маска не знает формы. Дешевле всего — разложить задел по формам одним `count(*) filter (where code ~ …)`.
- **Лечение / правило:** корзина-исключение обязана быть **гейтом, а не примечанием**: непустая корзина останавливает `--apply` и требует явного порога (`--allow-suspicious=N`), как это уже сделано для `--allow-ghosts`. Тихий пропуск неизбежно читается как успех — и читается им же в следующей сессии, из отчёта, где всё зелёное.
- **Родня:** брейновский [G176](../../brain_matrica/cross-project-ideas/GOTCHAS.md#g176) — «универсальный гейт, настроенный через исключение, обязан иметь рядом узкую проверку на выключенный инвариант». Здесь тот же класс, только исключение не в конфиге, а в регулярке.

## M42 — целый раздел UI отвечает «No handler registered for '…'» после чистки мёртвого кода

- **Симптом:** после релиза с чисткой «мёртвого» кода клиенты пишут в лог `unhandledrejection: Error invoking remote method 'warehouse:nomenclature:list': No handler registered`. Отваливается не одна кнопка, а целый контур (склад, спецификации, дефектовка, поиск). Живой случай 2026-07-25: #333 удалил `electron-app/src/main/ipc/register/erp.ts` как «поверхность мёртвого `erp:*`» — файл нёс **6 мёртвых** `erp:*` хендлеров и **~52 живых** (`warehouse:*`, `search:*`); v2026.725.1938 уехала на прод с мёртвым складом, hotfix 2026.725.2033 в тот же вечер.
- **Корень:** имя файла/модуля говорит о **происхождении** кода, а не о его текущем содержимом — за годы в «erp-файл» доросли живые хендлеры соседних доменов. Плюс IPC-связка `preload → ipcMain` идёт **по строковому каналу**: удаление `ipcMain.handle('x')` при живом `ipcRenderer.invoke('x')` не ломает ни типы, ни линт, ни тесты — компилятор эту границу не видит. Все гейты зелёные, дефект ловится только в рантайме.
- **Диагностика:** до удаления файла — инвентаризация **каналов**, а не символов: `grep -oE "ipcMain\.handle\(\s*'[^']+'" <file>` → для каждого канала `grep -rF "'<channel>'" electron-app/src/preload electron-app/src/renderer`. Хоть один живой потребитель = файл удалять нельзя, вырезать только мёртвые хендлеры. После правки — обратная сверка: каждый канал из `preload/index.ts` обязан иметь `ipcMain.handle` в `main/ipc/register/`.
- **Лечение:** восстановить файл из ревизии до чистки (`git show <sha>^:<path>`), вырезать реально мёртвое, вернуть `registerXIpc(ctx)` в `registerIpc.ts`. Проверять рантаймом (CDP-смоук зовёт каждый восстановленный канал через bridge), а не типами.
- **Правило:** knip/deadcode-сканер не видит IPC-границу — «мёртвость» surface'а по имени доказывать нельзя, только по инвентаризации каналов.

## M43 — у ВСЕХ клиентов разом падает pull `SQLITE_CONSTRAINT_*`, сервер здоров

- **Симптом:** `client.sync.failed` в критических событиях от всего парка сразу, текст `SqliteError: NOT NULL constraint failed: <table>.<column>`; на сервере `/health` ok, данные валидные. Живой случай 2026-07-25: `erp_engine_assembly_bom.engine_nomenclature_id` — 173 события за 3 дня, 8 живых серверных BOM (привязаны только к маркам, без номенклатуры двигателя) роняли pull у каждого клиента.
- **Корень:** **клиентская схема строже серверной.** PG-колонка nullable, а клиентская drizzle-миграция создала её `NOT NULL` — расхождение не проявляется, пока в проде не заведут первую строку с NULL. С этого момента ломается не один клиент, а все: строка приезжает всем.
- **Диагностика:** взять имя таблицы/колонки прямо из текста ошибки → `\d <table>` на проде (nullable?) против клиентского `drizzle/*.sql` + `PRAGMA table_info`. Заодно `SELECT count(*) FROM <table> WHERE <col> IS NULL` — сколько строк уже отравляют pull.
- **Лечение:** привести клиента к серверу. `ALTER TABLE` в SQLite **не умеет снимать NOT NULL** → пересборка таблицы (create-new → `INSERT … SELECT` тем же составом колонок → drop → rename → пересоздать индексы) в **безусловном** шаге миграции (`ensureClientSchemaParity` в `main/database/migrate.ts`), а не в version-chained цепочке — иначе свежая установка её пропустит ([[client-schema-two-migrators]]).
- **Правило:** клиентская схема — **зеркало** серверной, а не её ужесточение. Любое `NOT NULL`/`UNIQUE` на клиенте, которого нет на сервере, — отложенная поломка всего парка.

## M44 — watchdog рапортует `recovery succeeded (exit=0)`, а ярлыки так и не вернулись

- **Симптом:** пропали ярлыки клиента; watchdog честно детектит (`shortcuts missing`), качает/запускает installer, пишет `recovery succeeded (installer exit=0)` — а ярлыков на месте нет. Следующий проход через 15 минут повторяет всё заново: успех **сбрасывает** счётчик backoff, поэтому 136 МБ качаются вечно. Поймано живой приёмкой на rmz4val 2026-07-25 (ветка #334).
- **Корень:** тихий one-click NSIS от electron-builder трактует **отсутствующий** ярлык как «пользователь удалил осознанно» и не создаёт его заново — переустановка возвращает файлы приложения, но не `.lnk`. То есть выбранный инструмент восстановления физически не умеет чинить ровно ту поломку, ради которой звался.
- **Диагностика:** после «успешного» прогона проверять **не exit-код, а сам симптом** (`Test-Path` обоих `.lnk`). Второй слой: путь к рабочему столу — `%USERPROFILE%\Desktop` неверен при редиректе (на rmz4val десктоп на `D:\`), брать `[Environment]::GetFolderPath('Desktop')`.
- **Лечение:** создавать `.lnk` напрямую (`WScript.Shell`, target = `appExePath` из handshake) — секунды вместо 136 МБ; переустановку оставить только для «нет exe» / команды владельца, и после неё **доздавать** ярлыки тем же способом (#341).
- **Правило:** «recovery succeeded» обязан означать «симптом исчез», а не «инструмент вернул 0». Проверка успеха ставится на тот же предикат, что и детект.

## M45 — сохранение падает `<path>: элемент <uuid> не найден`, хотя объект в базе есть

- **Симптом:** карточка отказывается сохраняться (`freeWorks[0].partId: элемент 496c03a9… не найден`), при этом `SELECT` находит строку живой и не удалённой. Дальше сыплется каскад **несвязанных на вид** жалоб: «наряд не найден» при выдаче, «BOM не применён» после переоткрытия — потому что при deferred-create отклонённое сохранение означает, что строки нет вовсе. Живой случай 2026-07-27 (наряд на сборку, PR #359).
- **Корень:** ссылочный гард ищет **все** ссылки в `entities`, а каталожные сущности (деталь/номенклатура/изделие/услуга) переехали в `directory_parts`/`erp_nomenclature`. Ровно регресс #319, починенный на сервере в #325 — **и не отзеркаленный на клиент**: валидатор живёт в двух местах (`backend-api/…/sync/entityReferenceGuard.ts` и `electron-app/…/services/workOrderService.ts`), фикс применили в одном.
- **Диагностика:** взять uuid прямо из текста ошибки → искать во **всех** хранилищах, не только в `entities`: `SELECT … FROM directory_parts / erp_nomenclature / entities WHERE id=…`. Нашёлся не в `entities` → это оно. Затем `grep` по тексту сообщения: если он встречается и в backend, и в electron — валидатор дублирован.
- **Лечение:** каталожные типы резолвить как на сервере (`erp_nomenclature.id` + `directory_ref_id` + entities с каталожным `type_code`), не-каталожные — по-прежнему через `entities` с проверкой типа.
- **Правило:** правя гард/валидатор на сервере — **сразу грепни то же сообщение по клиенту**. Дублированная валидация чинится парой, иначе вторая половина всплывёт багом «сохранение молча не работает» через несколько релизов.

## M46 — «логин активен на 2 машинах» / парк клиентов размножается, старые версии не гаснут

- **Симптом:** предупреждение «логин активен на N машинах», хотя человек работает за одним компьютером (в тексте один и тот же hostname дважды); в `client_settings` у одного hostname 3–5 строк; в отчётах вечно висят «живые клиенты на версиях месячной давности» без hostname, которых физически нет. Живой случай 2026-07-27 (PC69, PR #360/#361).
- **Корень — два независимых:** (1) **identity хранилась только в стираемом месте** — `clientId` жил в settings внутри `matricarmz.sqlite`, и любая пересборка БД (self-heal, schema-rebuild после обновления) рождала клиента заново; умерший id ещё держится в окне «активен» рядом с новорождённым → ложный multi-machine. (2) **служебный агент дёргал клиентский эндпойнт** — watchdog опрашивал `/client/settings` за командой reinstall, а сервер засчитывал GET как heartbeat приложения → строка мёртвой установки вечно свежая со стейл-версией.
- **Диагностика:** `SELECT client_id, last_hostname, last_version, to_timestamp(last_seen_at/1000) … WHERE last_hostname = …` — если два id одного hostname и один «умер» за секунды до рождения второго, это пересборка БД, а не вторая установка. Строки **без** `last_hostname`, которые при этом «свежие», — почти наверняка служебный опрос: приложение всегда шлёт hostname, даже до логина.
- **Лечение:** identity — в sidecar вне БД (`%APPDATA%\MatricaRMZ\client-id.json`, рядом с watchdog-handshake), порядок чтения БД → sidecar → генерация; служебный агент помечает себя (`source=watchdog`), сервер отдаёт ему полезную нагрузку **без** `touchClientSettings`.
- **Правило:** идентичность рабочего места не может жить в хранилище, которое приложение умеет пересоздавать. И «кто живой» должен считаться только по heartbeat **приложения** — любой служебный опрос того же URL обязан быть отличим, иначе метрика парка врёт в сторону «всё живо».

## M47 — клик мышью не срабатывает, а с клавиатуры то же действие работает

- **Симптом:** пользователь кликает по строке выпадающей подсказки — выбор не происходит, вместо него срабатывает «защитный» сценарий (у нас — модалка «элемент не выбран» с сырым набранным текстом). Через `↓`/`Enter` тот же выбор коммитится безупречно. Живой случай 2026-07-27 (`EntityReferenceField`, PR [#363](https://github.com/Valstan/MatricaRMZ/pull/363)).
- **Корень:** компонент вешает на `document` **capture-listener** (`mousedown`, `useCapture=true`) со смыслом «клик мимо меня → сделай X», а проверку «мимо» делает через `rootRef.current?.contains(event.target)`. Его собственная выпадашка при этом рендерится **порталом в `document.body`** (чтобы не резалась `overflow`) → по DOM она «мимо», клик глотается `preventDefault + stopImmediatePropagation` и до `onClick` опции не доходит. Портал переносит узел в DOM, но не в модели пользователя.
- **Диагностика:** несимметричность «мышь ломается, клавиатура нет» — уже почти диагноз: клавиатурный путь идёт внутри компонента и мимо `document`-сторожа, мышиный обязан через него пройти. Для ревью: `document.addEventListener(…, true)` и `createPortal` в одном компоненте (или в паре «поле ↔ его выпадашка») = место, где надо спросить «а портал этот сторож пропускает?».
- **Лечение:** пометить портал data-атрибутом и внести в whitelist сторожа (`target.closest('[data-entity-lookup-popup]')`). **Не** `stopPropagation` внутри портала — он живёт в другом поддереве, до capture-листенера на `document` событие всё равно доходит первым.
- **Правило:** любая проверка «клик вне меня» через `contains()` обязана перечислять и свои порталы. Их у компонента обычно больше одного (у нас — сама выпадашка **и** кнопка-подсказка).

## M48 — операторы видят не все наряды, а суперадмин видит все (и потому не верит жалобе)

- **Симптом:** двое-трое операторов с полным доступом к «Нарядам» видят подряд идущий кусок списка и не видят остальное («с 81 по 115 нет»). Владелец под суперадмином открывает тот же список — всё на месте. Живой случай 2026-07-28: у двух операторов было видно 29 нарядов из 100.
- **Корень:** раздел доступа `restricted_work_orders` («Наряды закрытые») имеет **инвертированную** семантику уровня: `editor` там означает не «больше доступа», а «ограниченный ВЛАДЕЛЕЦ — мои наряды скрыты от всех остальных». Владелец выдал `editor` **себе** (читая это как расширение прав) → все наряды с `performed_by = <его логин>` стали закрытыми. Усилитель: под суперадминским логином работали на чужих машинах, поэтому на него записаны 54 наряда из 100. Второй усилитель — `canViewWorkOrder` начинается с `isSuperadminRole → true`, поэтому единственный человек, который мог заметить поломку, был от неё экранирован.
- **Диагностика:** «часть списка пропала у одних и цела у других» + жертва не совпадает с тем, кто менял настройку → сначала смотреть **владельца строк**, а не синк. `select performed_by, count(*) from operations where operation_type='work_order' group by 1` рядом с `select … where value_json like '%restricted_work_orders%'` даёт ответ за один заход. Не путать с застрявшим pull-курсором (M6/M8) — там пропажа одинаковая на машине целиком, а не по автору.
- **Лечение:** суперадминские membership-строки игнорируются при построении политики (`restrictedWorkOrderPolicyFromMemberships`), суперадмин убран из таблицы «Доступы по разделам» и из засева (`backfillSectionAccess`). Роль и так обходит разделы везде (`sectionLevelFor`, `sectionGate`, ledger-authz), поэтому строка ему ничего не давала — только вредила.
- **Правило:** если у роли есть bypass, её строка в таблице прав не должна существовать вовсе. Такая строка не даёт носителю ничего, но остаётся входом в другие политики — и ломает **чужой** доступ, оставаясь невидимой для владельца. Отдельно: раздел с инвертированной семантикой уровня подтверждающим диалогом не лечится (⚠️-confirm тут уже стоял с 2026-07-10 — и не спас).

## M49 — данные с машины не видит никто, правка «откатывается»: ОДНА строка заперла весь push

- **Симптом:** сущность, созданная на машине A, не видна ни на одной другой машине (у автора видна — она в его локальной реплике); правка карточки сохраняется, а после перезахода показывает старое значение. Выглядит как проблема прав/видимости — и лечится «не тем»: `force_full_pull` не помогает **никогда**, потому что сломан не приём, а отправка. Живой случай 2026-07-28: двигатель Я01АТ7829 + его атрибуты + правка наряда 101 неделями не покидали PC40; параллельно вторая машина каждую минуту сыпала `sync dependency rows skipped` на недоехавшую сущность.
- **Корень:** серверный гард ссылочной целостности (`entityReferenceGuard`) **кидал throw** → весь `/ledger/tx/submit` падал HTTP 400, и с машины не уезжало **ничего** (в батче 57 строк: сущности, атрибуты, операции, аудит — все заложники одной). Отравителем была строка со ссылкой на цех: цеха мигрировали из EAV **целиком** (`entities` → `directory_workshops`, в `entities` их 0), а резолвер искал только в `entities` → живой «Цех №1» = `not_found`. Третья инстанция класса «гард ссылок ходит в устаревшую таблицу» (детали — регресс #319, brain G173).
- **Диагностика:** первым делом **лог клиента**, не сервер: `grep -E "push failed|sync ok pushed" %APPDATA%/@matricarmz/electron-app/matricarmz.log` — `pushed=0` при непустом `push pending total=N` и повторяющемся `status=400` с одним и тем же `row_id` = диагноз за минуту. Серверный признак-компаньон: чужая машина в цикле пишет `dependency rows skipped … missing:1` — она ссылается на то, что заперто у соседа. Проверка «доехало ли»: `select … from attribute_values … where value_json like '%<номер>%'` на проде — пусто при живой карточке у автора = очередь стоит.
- **Лечение:** гард переведён на **per-row partition** (`{allowed, denied}`, как authz-гейт) — виновная строка уходит в `skipped`, остальной батч применяется; клиент держит `denied` строки `pending` и ретраит, так что «дозревшая» ссылка уезжает сама. Плюс резолвер дочитывает `directory_workshops`, плюс критсобытие `server.sync.reference_denied` (PR [#386](https://github.com/Valstan/MatricaRMZ/pull/386)).
- **Правило:** **валидационный гейт над оффлайн-очередью не имеет права на `throw`.** Батч — не транзакция пользователя, а произвольный срез чужих друг другу строк; отказ обязан быть построчным, иначе одна строка берёт в заложники всю машину. И такой отказ обязан быть **видимым** (критсобытие/лог у владельца): здесь он был молчаливым, поэтому жил неделями и был принят за проблему доступов.

## M50 — кнопки UI «в куче» с жирной чёрной рамкой: CSS-файл осиротел, а все гейты зелёные

- **Симптом:** раздел UI выглядит «фантасмагорично» — элементы текут строками вместо колонки, у каждой кнопки толстая чёрная рамка, фон серый. Живой случай 2026-07-29: панель «РАЗДЕЛЫ» v3-оболочки (жалоба владельца «кнопки свалены в непонятную кучу»). Ломается **весь** блок сразу, а не отдельное правило — это и есть подпись симптома.
- **Корень:** CSS-файл больше никем не импортируется. `shellV2.css` подключался снесённой v2-оболочкой; в этап 6 ([#398](https://github.com/Valstan/MatricaRMZ/pull/398)) рендереры v1/v2 удалили, а `ButtonPanel.tsx` из той же папки остался жить в v3 — вместе со своими классами, у которых больше нет правил. Дальше рисует UA-таблица стилей: `div` → `display:block` (кнопки как inline-block текут строками), `button` → `border: 2px outset ButtonBorder` (та самая «жирная чёрная обводка»).
- **Почему гейты молчали:** ни один не смотрит на вид. `typecheck`/`lint`/`vitest` про CSS ничего не знают; CDP-смоук v3-оболочки проверял **поведение** (клик открывает список, вкладка закрывается) и на голом UA-стиле проходит так же зелено. Регресс уехал на прод в v2026.728.2350 и прожил сутки до жалобы владельца.
- **Диагностика:** одна строка в CDP — `getComputedStyle(document.querySelector('.<класс>')).borderTopStyle === 'outset'` (или `display` контейнера `=== 'block'` там, где ждёшь `flex`) → стилей нет вообще, дальше не гадать. Кто импортирует файл: `grep -rn "<имя>.css" src/`; пусто = осиротел.
- **Лечение:** CSS импортируется **из своего компонента** (`import './buttonPanel.css'` в `ButtonPanel.tsx`), а не из оболочки-родителя — тогда удаление любого потребителя не может его отцепить. Мёртвые правила снесённых оболочек выпилены вместе с файлом (PR [#410](https://github.com/Valstan/MatricaRMZ/pull/410)).
- **Правило:** **CSS живёт рядом с компонентом и импортируется им.** Общий файл-«оболочка» переживает свою оболочку молча. И: при сносе крупного слоя UI прогонять смоук, который щупает **геометрию/стиль** (ширина, `display`, рамка), а не только «клик сработал» — поведенческий смоук слеп ровно к этому классу поломок.

## M51 — первая тяга разделителя панелей срывается на первом же пикселе

- **Симптом:** разделитель `react-resizable-panels` при первом перетаскивании сдвигается на 5–10 px и перестаёт следовать за мышью; вторая и последующие тяги работают нормально. В смоуке выглядит как «trusted-ввод не доезжает», хотя мышь тут ни при чём.
- **Корень:** персист ширины висел на `onLayoutChange` — а он зовётся **на каждый пиксель** движения. Дебаунс-таймер (400 мс) успевал выстрелить внутри длинной тяги, писал prefs → `setState` → ре-рендер группы посреди drag'а → библиотека теряла сессию перетаскивания. Особенно заметно на **первой** тяге от дефолта (ширины ещё нет в prefs, поэтому guard «изменилось ли значение» пропускал вообще всё, включая раскладку самого маунта).
- **Диагностика:** сохранённый процент после тяги равен ширине **до** неё (или кламп-границе), а не той, куда дотянули; вторая тяга подряд проходит целиком.
- **Лечение:** персист переведён на `onLayoutChanged` (прошедшее время) + `meta.isUserInteraction` — колбэк зовётся один раз после отпускания кнопки, маунт и программные пересчёты не пишут ничего; дебаунс не нужен. Прежний комментарий «`isUserInteraction` не срабатывает на синтетике смоука» верен только для JS-`dispatchEvent`: на `Input.dispatchMouseEvent` (trusted) флаг приходит `true`.
- **Правило:** размеры панелей персистить **на завершении жеста**, а не в его процессе. Пишущий колбэк внутри drag'а — это ре-рендер внутри drag'а.


## M52 — строка «synced», ошибок нет нигде — а на сервере её нет и не будет

- **Симптом:** сущность (двигатель asia2/PC51, 2026-07-29 — второй инцидент класса после Я01АТ7829/M49) создана на машине, видна автору, но не доезжает ни до сервера, ни до других клиентов. Отличие от M49: **ни единого следа** — `reference_denied` = 0, у клиента `pushed=0` без ошибок, наряды с этой машины ходят нормально. Косвенный серверный маркер — чужой/свой `sync dependency rows skipped (engine_entity missing)` на операции, ссылающиеся на недоехавшую сущность.
- **Корень:** строка в локальной реплике помечена `sync_status='synced'`, но `last_server_seq IS NULL` — т.е. сервер её ни разу не возвращал pull'ом, подтверждения не было. `collectPending` берёт только `pending` → строка исключена из push навсегда. Как строка попадает в это состояние: fallback-ветка клиента «ответ без `applied_rows` → пометить synced ВСЁ отправленное» (включая скипнутое сервером), либо исторический скип.
- **Диагностика:** сигнатура ищется одним запросом по реплике: `sync_status='synced' AND last_server_seq IS NULL` при возрасте старше пары часов = застрявшие. На сервере — сущности нет; `force_full_pull` НЕ лечит (сломана отправка, не приём — как в M49).
- **Лечение:** self-heal `requeueUnconfirmedRows` в `collectPending` (PR #414): такие строки (окно 45 дней, грейс 30 мин, ≤500/цикл) возвращаются в `pending` — повторный push идемпотентен (upsert по id, LWW-гарды). Попутно seq-less «воскрешение» поверх серверного тумбстоуна переведено с `throw sync_conflict` (блокировал весь push машины) на per-row skip — то же правило M49.
- **Правило:** **«отправлено» ≠ «доставлено»: подтверждением служит только возврат строки сервером (`last_server_seq`).** Любая пометка `synced` без серверного подтверждения — это молчаливая потеря данных, ждущая своего часа; ей положен self-heal по сигнатуре, а не разбор руками разработчика на каждой машине.

## M53 — выбор в пикере «не применяется»: поле показало новое, сохранилось старое

- **Симптом:** оператор выбирает значение в ссылочном пикере (двигатель сборки в шапке наряда), поле показывает выбранное, но после сохранения/переоткрытия карточки там прежнее значение. Жалоба звучит как «двигатель не меняется» (наряд 101, 2026-07-28…30 — **третий** корень той же жалобы после M49 и #411).
- **Корень (два слоя):**
  1. **Обработчик `onChange` может молча выйти, не тронув payload.** В `applyAssemblyPlan` ветка `bom_conflict` («у марки не выбран единственный основной BOM») выставляла список кандидатов и выходила с комментарием «двигатель сменится после выбора BOM» — то есть основное намерение оператора не выполнялось вообще, а единственной подсказкой был маленький `<select>` рядом с полем.
  2. **Ветка была не редкой, а единственной.** `resolveAssemblyPlan` требовал ровно один линк с флагом `is_default_for_brand`, а редактор BOM **никогда не отправляет** `defaultForBrandIds` — на проде флаг не выставлен ни у одной из 24 связок. Значит `bom_conflict` возвращался на **любой** двигатель любой марки: смена двигателя в сборочном наряде не работала ни у кого и никогда.
- **Почему это выглядит как «показало и откатило»:** `EntityReferenceField` держит собственное отображаемое значение после выбора и не сверяется с payload. Поле честно рисует выбранное, хотя `patch()` не вызывался. Расхождение всплывает только на перезагрузке карточки — оператор читает это как «программа откатила мою правку».
- **Диагностика:** сверять не UI, а payload — `workOrders.get(id)` → `assemblyEngineId` и `freeWorks[].engineId`. Если поле показывает новое, а payload держит старое, ищи ветку `onChange`, которая `return`'ится без `patch`. Со стороны сервера ветка видна одним curl'ом: `GET /warehouse/assembly-plan?engineId=…` → `code`.
- **Лечение:** (1) ветка `bom_conflict` теперь меняет двигатель сразу (`applyEngineKeepingRows`, ручное отклонение от BOM), спецификация — необязательный второй шаг; (2) единственная активная BOM марки выбирается и без флага «основная» (`pickDefaultAssemblyBom`), дубли связок дедуплицируются по `bomId`.
- **Правило:** **пикер, который показывает своё значение, не является доказательством записи.** Смоук на такие поля обязан читать payload после сохранения — проверка «поле показывает новое» остаётся зелёной под самим багом (проверено откатом правки: упали только payload-проверки). И: обязательное поле-флаг, которого нет в UI, — это не «настройка по умолчанию», а мёртвая ветка, включённая всем.

## M54 — элемент есть в DOM, но не отрисован: панель без раскладки, пока её вкладка не в фокусе

- **Симптом:** CDP-смоук находит узлы (`querySelectorAll` возвращает их, проверки «элемент найден» зелёные), но список рендерит **0 строк** при честном счётчике «Всего: 7», а доверенный `Input.dispatchMouseEvent` по «найденному» элементу ни во что не попадает. Скриншот при этом может показывать нормальную страницу — потому что снят уже после того, как вкладку сфокусировали.
- **Корень:** v3-оболочка монтирует страницу в панель, которая **не получает раскладку, пока её вкладка не активна**. Узлы в DOM есть, но `getBoundingClientRect()` у них `0×0` в точке `(0,0)`; виртуализированная таблица меряет нулевую высоту контейнера и честно рисует 0 строк. Прошлый разбор (2026-07-30, утро) списал это на `flex:1 1 auto` в `VirtualTable` и увёл сессию в шесть подходов «драйвить жестами не выходит» — диагноз был неверный.
- **Лечение:** перед любыми измерениями и кликами **сфокусировать вкладку** — кликнуть соответствующую кнопку в `.v3-tab-strip` (для списка «Список …», для карточки «Карточка …»), затем дождаться ненулевой ширины целевого элемента. После этого и список рендерится целиком, и строка открывается обычным доверенным кликом.
- **Правило (главное):** **«узел найден» — не доказательство отрисовки.** В скрытой панели находится всё и всегда, поэтому проверка вида «элементов N > 0» зелёная под сломанным экраном, а «0 отмечено из 0 отрисованных» зелёная на пустом DOM. Доказательством может быть только ненулевой прямоугольник **и** попадание hit-теста: `document.elementFromPoint(центр) === элемент`. Родственно M53 (виджет, показывающий своё значение, — не доказательство записи): в обоих случаях гейт обязан спрашивать не тот слой, который умеет соврать.
- **Смежные грабли того же прогона:** класс кнопки закрытия вкладки — `.v3-tab-close` (несуществующий `.v3-card-tab-close` даёт цикл очистки, который молча ничего не закрывает); у своего CDP-`send()` обязан быть таймаут, иначе занятый renderer даёт бесконечное молчание вместо ошибки; тяжёлые карточки (BOM на 553–561 строк) после сохранения занимают главный поток на минуты — для смоуков брать лёгкие фикстуры.
- **Рабочий пример:** `.claude/skills/verifier-electron/scripts/cdp-bom-default-brand-render.mjs` (14 проверок, обе мутации ловятся).

## M55 — смоук «запись появилась» зеленеет при выключенной фиче: засчитана строка ПРОШЛОГО прогона

- **Симптом:** CDP-смоук утверждает «в аудите/журнале появилась запись X» и остаётся зелёным даже после того, как соответствующий вызов полностью убран из кода. Мутационная приёмка проваливается: ломаешь фичу — тест не краснеет.
- **Корень:** dev-БД стенда **персистит между прогонами**. Ассерт ищет запись по `action`/`entityId` без отсечки по времени, находит строку, которую сам же и создал в предыдущем прогоне, и рапортует успех. Симптом видно только по метке времени: в диагностике `createdAt` совпадает с прошлым запуском до миллисекунды.
- **Лечение:** брать `const runStartedAt = Date.now()` **до** действия и фильтровать `createdAt >= runStartedAt`; в лог печатать саму запись, чтобы метка была видна глазом.
- **Правило (главное):** для любой проверки вида «после действия в базе появилось Y» состояние базы на старте прогона — часть теста. Либо отсечка по времени, либо уникальный per-run маркер в самих данных; «искать по типу записи» на персистентной базе не доказывает ничего.
- **Родственная грабля:** тот же класс, что «эталон брался из поля ДО нормализации» (маркер прошлого прогона становится эталоном, сравнение вырождается) — оба ловятся только мутацией, ни один не виден по зелёному прогону.
- **Рабочий пример:** `.verifier-electron/_smoke-engine-close-actions.mjs` (gitignored), поймано 2026-08-02 на аудите правки двигателя.

---

## M56 — «offline» в тестах: `navigator` в Node есть, а `onLine` у него нет

- **Симптом:** любой вызов через шим сети в vitest падает `Error: offline` — при том, что `globalThis.fetch` замокан и фейковый сервер отвечает. В браузере тот же код работает. Внешне похоже на «мок не подхватился», и отладка уходит в сторону мока.
- **Корень:** предикат вида `typeof navigator !== 'undefined' ? navigator.onLine : true`. В Node 22 глобальный `navigator` **существует** (Web-совместимость), но свойства `onLine` у него нет → `undefined` → falsy → «офлайн». Ветка «мы не в браузере, считаем что онлайн» не срабатывает никогда.
- **Лечение:** офлайном считать только явный отказ: `typeof navigator === 'undefined' || navigator.onLine !== false`. Места в репо: `android-app/src/shims/netFetch.ts`, `android-app/src/shims/electron.ts` (`net.isOnline`).
- **Правило (главное):** наличие браузерного API нельзя проверять через существование его контейнера — Node тянет к себе браузерные глобалы (`navigator`, `crypto`, `fetch`, `structuredClone`), и такие проверки протухают молча. Проверять надо само свойство, а дефолт выбирать так, чтобы отсутствие сигнала не блокировало работу.
- **Поймано:** 2026-08-03, порт клиента на Android (Ф1), при первом прогоне `runSync` на фейковом сервере.

---

## M57 — semgrep-гейт краснеет от `unsafe` в Go: нативный вызов Windows API рубится SAST'ом

- **Симптом:** PR со сторожем (`watchdog/*.go`) проходит `go vet` и сборку, но чек **semgrep** падает с 8 блокирующими находками вида «Using the unsafe package in Go … can lead to buffer overflows» (`sg.run/qxEx`). Локально это не видно вовсе: Go на dev-машине может быть не установлен, а semgrep гоняется только в CI.
- **Корень:** `.github/workflows/sast-semgrep.yml` на PR запускает `p/security-audit` с `--error`, и правило про `unsafe` — ERROR. Любой канонический вызов Windows API из stdlib (`SHGetKnownFolderPath` + `CoTaskMemFree` + ручной обход UTF-16, `uintptr↔unsafe.Pointer`) даёт по находке на строку. То есть «как делает `golang.org/x/sys`» здесь не проходит по умолчанию.
- **Лечение (в порядке предпочтения):** (1) **не звать API вовсе** — если значение уже знает Electron-клиент, пробросить его в handshake (так сделано с папкой рабочего стола: `app.getPath('desktop')` → `desktopDir`, ADR-0002); (2) если вызов неизбежен — точечный `// nosemgrep: use-of-unsafe-block` **на строке** с объяснением, почему это безопасно (например `unsafe.Sizeof` — compile-time, без арифметики над указателями).
- **Правило (главное):** прежде чем писать в Go нативный вызов ради «убрать powershell», спроси, не знает ли ответ уже клиент. Сторож общается с клиентом файлом-handshake — расширить его дешевле и безопаснее, чем тащить в сторожа syscall-код, который не проверить ни линтером, ни тестами, и который ломается тихо.
- **Поймано:** 2026-08-04, вынос исполняемого контура из Roaming AppData (ADR-0002).

## M58 — обновление «не находится», хотя прод раздаёт его правильно

- **Симптом:** оператор говорит «обновление не приходит», ставит вручную. На проде всё зелено: `/updates/status` отдаёт актуальный `latest`, `lastError: null`, `.exe` и `.blockmap` → 200. В `matricarmz-updater.log` клиента видно, что обновление **находилось и считалось**: `lan-update: delta plan: 14.83 MiB of 129.98 MiB … worth-it=yes`, а через десятки секунд — `stale update lock removed, update flow reset`. И так по кругу.
- **Корень:** `recoverStuckUpdateState()` вызывается на КАЖДОМ старте клиента (`main/index.ts`, до `runAutoUpdateFlow`). Увидев `update.lock`, он звал `cleanupUpdateCache(current)`, а тот стирает все файлы в корне updates-каталога — вместе с топливом delta: `matrica_rmz_update.exe`, `<installer>.blockmap`, `<installer>.cache.json`. Закрыл клиент посреди загрузки → следующий запуск стёр базис → delta невозможна (`no cached installer sidecar`) → качается полный installer (~136 МБ) с нуля. На узком канале не доезжает никогда, а цикл самоподдерживающийся. Вторым слоем: lock снимался без учёта возраста и живости владельца, тогда как `acquireUpdateLock` держит его 2 часа — два механизма противоречили друг другу.
- **Диагностика:** грепни `matricarmz-updater.log` (в `userData`, у клиента это `%APPDATA%\@matricarmz\electron-app`) на `delta plan` и `stale update lock removed`. Пара «план посчитан → через минуту сброс» = эта грабля. Проверь заодно, лежат ли в updates-каталоге все три файла топлива: без `.cache.json` delta не включится молча.
- **Лечение:** политика вынесена в `updateLockPolicy.ts` (`decideStaleLock`): возраст > 2ч побеждает всё (PID переиспользуются), иначе живого владельца не трогаем, мёртвого снимаем сразу. `recoverStuckUpdateState` удаляет только недособранный `<installer>.delta-new.exe` мёртвого процесса — топливо delta переживает перезапуск.
- **Правило:** «подчистить залипшее состояние» на старте не должно трогать кэш, который дорого набирался. Разделяй мусор (temp мёртвого процесса) и актив (топливо delta) — цена ошибки здесь не «лишний файл», а неработающая доставка обновлений на весь парк.
- **Поймано:** 2026-08-04, при разборе жалобы «обновление автоматом не находится» на PC40.

## M59 — после установки поверх работающего клиента пользователь остаётся на СТАРОЙ версии

- **Симптом:** установщик отработал (exit 0), файлы новой версии на диске, ярлыки и реестр обновлены — а в интерфейсе у оператора прежняя версия. `Get-Process MatricaRMZ | Select Id,StartTime,Path` показывает процессы **из прежнего каталога** со `StartTime` ДО установки: старый клиент пережил установку и продолжает работать.
- **Корень:** `KillClientProcesses` (installer.nsh) сперва пробует мягкий `taskkill /IM`, а Electron-клиент его **не берёт** — проверено на PC40: 5 процессов пережили мягкий kill, потребовался `/F`. Следом макрос показывает `MessageBox … /SD IDYES`, но **`/SD` действует только в silent-режиме** (`/S`): при ручном запуске установщика диалог реально рисуется и ждёт человека. Сторож ставит с `/S`, поэтому у него ветка форс-килла отрабатывает сама — а ручная установка ведёт себя иначе. Отдельно усугубляет переезд каталога (2026-08-04): установка идёт в НОВУЮ папку, файлы старой не заняты, конфликта нет вовсе — установщику ничто не мешает завершиться успешно, оставив старый клиент работать.
- **Почему это не бьёт по штатному автообновлению:** там клиент закрывает себя сам (`update-helper` ждёт выхода родителя и только потом запускает installer), так что поверх живого процесса установка не идёт.
- **Диагностика:** `Get-Process MatricaRMZ | Select Id,StartTime,Path` — сверить `Path` с `InstallLocation` в `HKCU\Software\<APP_GUID>` и `StartTime` со временем установки.
- **Лечение:** после ручной установки закрыть клиент принудительно (`taskkill /F /IM MatricaRMZ.exe`) и запустить заново из нового пути. При переезде каталога это ещё и условие подчистки прежней папки: её удаляет клиент при старте (`sweepLegacyInstallDir`), а пока работает старый процесс — папка занята и остаётся.
- **Поймано:** 2026-08-04, приёмка переезда каталога установки на PC40.

## M60 — новый workflow нельзя запустить вручную, пока он ни разу не отработал сам

- **Симптом:** файл `.github/workflows/<новый>.yml` смержен в `main`, YAML валиден, `workflow_dispatch` в нём объявлен — а `gh workflow run <файл>.yml --ref main` отвечает `HTTP 404: workflow … not found on the default branch`. В `gh workflow list` и в `GET /actions/workflows` его тоже нет (`total_count` не вырос), при этом остальные workflow на пуши в `main` реагируют штатно, то есть Actions не «лежит».
- **Корень:** GitHub индексирует новый workflow-файл не в момент появления на дефолтной ветке, а когда впервые **исполняет** его. До первого запуска он для API не существует, поэтому `workflow_dispatch` по нему недоступен — классическая курица-яйцо: единственный объявленный триггер требует индексации, а индексация требует запуска.
- **Диагностика:** отличить от синтаксической ошибки просто — распарсить файл локально (`node -e "require('js-yaml').load(...)"`, js-yaml лежит в pnpm-сторе) и проверить, что нет `startup_failure`-прогонов: `gh api "repos/<owner>/<repo>/actions/runs?per_page=15" --jq '.workflow_runs[] | select(.conclusion=="startup_failure")'`. Пусто + валидный YAML = эта грабля, а не битый файл.
- **Лечение:** дать workflow триггер, который выстрелит сам. Практичнее всего `pull_request` с фильтром по путям — он берёт файл с ветки PR, поэтому срабатывает ещё до всякой индексации дефолтной ветки; после первого прогона workflow появляется в списке и `workflow_dispatch` начинает работать. Ждать «пока проиндексируется» бесполезно — 20 минут не помогли.
- **Правило:** не закладывайся на `workflow_dispatch` как на единственный триггер нового workflow: до первого запуска дёрнуть его нечем.
- **Поймано:** 2026-08-04, ввод `android-apk-build.yml` (сборка APK планшетного клиента).

## M61 — Android: boot падает «Queries can be performed using SQLiteDatabase query or rawQuery methods only», при зелёных тестах

- **Симптом:** планшетный клиент на старте выводит текст ошибки (красный экран `reportBootFailure`): `Execute: unknown error … Queries can be performed using SQLiteDatabase query or rawQuery methods only`. На эмуляторе/в unit-тестах (`better-sqlite3`-стенд) ничего не падает.
- **Корень:** `PRAGMA journal_mode = WAL` (первый оператор boot) шёл через `conn.execute()`. `@capacitor-community/sqlite` реализует `execute` через `execSQL`, который **не умеет statements, возвращающие строки** (PRAGMA возвращает результат) — плагин бросает именно это исключение. Ограничение заявлено в `Limitations` плагина, но его легко пропустить: `execute` на desktop-стенде работает, и юнит-тесты адаптера все зелёные.
- **Диагностика:** найти в адаптере все вызовы `execute` и проверить, не попадает ли туда row-returning SQL (PRAGMA, SELECT). Android-стек выдаёт ошибку только на устройстве; эмулятор то же самое — диагностировать через текст boot-ошибки на экране.
- **Лечение:** в `exec()` маршрутизировать одиночные row-returning statements через `conn.query()` (у нас: `planQuery(sql).kind === 'raw'` и `(sql.match(/;/g) ?? []).length <= 1` → `objectRows` через `query`, иначе `execute`). Регресс-тест: `android-app/src/platform/capacitorSqlite.test.ts` — PRAGMA уходит в query, BEGIN/COMMIT/multi-statement — в execute.
- **Правило:** для android-адаптера считай `execute` пригодным только для non-returning statements; любую PRAGMA/SELECT — только через query-путь.
- **Поймано:** 2026-08-05, первый живой boot планшетного APK 2026.805.1128 (PR #481).

## M62 — Планшет «нет связи»: CORS allow-list прода режет Origin встроенного WebView

- **Симптом:** Android-клиент (Capacitor WebView) открывает экран входа и показывает «сервер: нет связи», хотя `https://<домен>/health` из браузера/curl отвечает 200.
- **Корень:** WebView шлёт `Origin: capacitor://localhost` (или `https://localhost` при `androidScheme: 'https'`), а прод-бэкенд держит строгий CORS allow-list `MATRICA_CORS_ORIGINS` (CSV). Чуждый Origin → `500 {"error":"CORS: origin not allowed: capacitor://localhost"}` на **каждый** запрос (health/auth/sync). Правка `.env` на сервере легко теряется: переменная не была задокументирована в `.env.example`, а при пересоздании env без неё клиенты снова отваливаются.
- **Диагностика:** `curl -i -H "Origin: capacitor://localhost" https://<домен>/health` → смотреть статус и текст ошибки (воспроизводится и с `https://localhost`). Проверить фактический `.env` на сервере (`dotenv/config` грузит локальный `backend-api/.env`, а не только systemd EnvironmentFile).
- **Лечение:** добавить origin'ы WebView в `MATRICA_CORS_ORIGINS` (`<домен>,capacitor://localhost,https://localhost`) в прод-`.env`, рестарт сервисов, проверить `/health` с обоими Origin. Документирование — `backend-api/.env.example`.
- **Правило:** любой новый тип клиента со своим origin (встраиваемый WebView, Electron, скрипты) — проверь его Origin-заголовок против CORS allow-list до переноса на прод.
- **Поймано:** 2026-08-05, первый живой синк планшета (PR #482, фикс — правка прод-env).

## M63 — Правило `display: none` по классу молча не срабатывает: узел размечен инлайновым `style`

- **Симптом:** новое CSS-правило вида `.some-gate .my-toolbar { display: none }` не прячет узел, хотя селектор совпадает (проверено `el.matches(...)`), правило есть в `document.styleSheets`, а `getComputedStyle` показывает `display: flex`.
- **Корень:** почти весь хром renderer'а размечен **инлайновыми стилями** (`style={{ display: 'flex', … }}` прямо в JSX). Инлайн-объявление сильнее любого селектора из таблицы стилей — специфичность тут не поможет.
- **Диагностика:** `getComputedStyle(el).display` против `el.style.display`. Если второе непусто — правило проиграло инлайну, а не «не нашлось».
- **Лечение:** в гейтированном файле стилей писать `display: none !important` (инлайн без `!important` проигрывает). Гейт при этом обязателен: правило должно висеть под платформенным атрибутом корня, иначе `!important` расползётся по десктопу. Пример — `renderer/src/ui/shell/chromeShell.css` (планшетное скрытие шапки/вкладок/тулбаров).
- **Правило:** прежде чем прятать чужой узел классом, посмотри, есть ли у него инлайновый `display`. Альтернатива `!important` — снимать инлайн из JSX, но это правка чужого компонента ради стиля.
- **Поймано:** 2026-08-05, планшетный режим «данные на весь экран».

## M64 — Выдвижная панель на `position: fixed` + `transform`: на старте выезжает с экрана, а меню внутри клипается

- **Симптом:** две беды одной причины. (1) При запуске приложения панель видна и **уезжает** за край на глазах у оператора. (2) Контекст-меню внутри панели (`position: fixed`) обрезается прокруткой самой панели или уезжает мимо пальца.
- **Корень:** (1) начальное значение `transform` — `none`, поэтому первая же отрисовка с `transition: transform` анимирует «из открытого в закрытое»: браузеру не с чего стартовать иначе. (2) Любой ненулевой `transform` у предка делает его **containing block** для `position: fixed` потомков — меню начинает позиционироваться и клипаться относительно панели, а не вьюпорта.
- **Диагностика:** `getComputedStyle(el).transform` у панели (`matrix(1,0,0,1,0,0)` при ожидаемом сдвиге = правило не применилось или анимация ещё идёт); `el.getAnimations()` покажет висящий transition. Полезно: в неотрисовывающемся окне (свёрнутая панель браузера) transition замирает на первом кадре — измерения врут, отключай анимации (`*{animation:none!important;transition:none!important}`) перед замерами геометрии.
- **Лечение:** (1) вешать `transition` только со второго кадра — атрибут `data-mx-ready` ставится в `requestAnimationFrame` после монтирования (`shell/ChromeDrawer.tsx`), правило `transition` висит на `[data-mx-ready]`. (2) по `transitionend` (плюс страховочный таймаут) снимать transform у **открытой** панели — `data-mx-settled='1'` → `transform: none`.
- **Правило:** выдвижная панель = `transform` только в движении; в покое его быть не должно. И никакого `transform`/`filter`/`perspective` на предках оболочки (`.v3-shell`, контейнеры `Page.tsx`) — `position: fixed` внутри схлопнется в их прокручиваемый бокс.
- **Поймано:** 2026-08-05, панель «РАЗДЕЛЫ» как выдвижная в планшетном режиме.

## M65 — Спорадический `502` на длинной серии POST: keep-alive Node короче, чем у nginx

- **Симптом:** массовая операция (импорт остатков 1С — сотни последовательных `POST /warehouse/nomenclature`) падает на **случайной** позиции с `HTTP 502: 502 Bad Gateway nginx/…`. Повтор проходит дальше и спотыкается в другом месте. В логах backend'а — ничего: ни исключения, ни строки о запросе.
- **Корень:** гонка keep-alive. У Node дефолтный `server.keepAliveTimeout` = **5 с**, у nginx пул к upstream (`keepalive 32`) держит соединение простаивающим до **60 с**. Node закрывает сокет первым, nginx отправляет в него следующий запрос → `upstream prematurely closed connection while reading response header` → 502. **POST при этом не ретраится** (`proxy_next_upstream` не перекидывает non-idempotent запрос, который уже ушёл), поэтому ошибка доезжает до клиента как есть. Родственная причина той же сигнатуры — рестарт сервисов без graceful shutdown: SIGTERM-хендлера не было, in-flight запросы обрывались.
- **Диагностика:** отделить 502 от ошибок приложения. Если роут ловит свои исключения и возвращает `{ok:false}` (у нас — HTTP 400), то **502 означает, что Node не ответил вообще**: смерть процесса, обрыв соединения или пустой upstream. Смотреть `error.log` nginx на `upstream prematurely closed`; проверить `server.keepAliveTimeout` (в коде, не в конфиге — дефолт молчаливый); `journalctl -u <service>` на предмет рестарта в ту же секунду.
- **Лечение:** серверные таймауты обязаны быть **длиннее** nginx'овских: `server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000` (`backend-api/src/index.ts`). Плюс graceful shutdown по SIGTERM/SIGINT (`server.close()` + принудительный выход по таймауту) — иначе любой `systemctl restart` в рабочее время даёт ту же картину. На клиенте — ретрай гейтвейных статусов **только для идемпотентных** вызовов (у создания без id ретрай запрещён: задвоит запись).
- **Правило:** любой Node за nginx — задавай `keepAliveTimeout`/`headersTimeout` явно и держи их выше upstream keep-alive прокси. Дефолт 5 с безопасен только для прямого выхода в интернет, не за прокси с пулом.
- **Поймано:** 2026-08-08, боевой импорт остатков 1С у владельца (фикс — PR #500).

## M66 — «Не грузится» только на Android-планшете: IN()-список упёрся в лимит 999 переменных

- **Симптом:** экран со списком (наряды, каталог двигателей) на планшете пуст или показывает ошибку, хотя ровно тот же код на десктопе работает; сеть и синк при этом в порядке.
- **Корень:** портированный сервис строит `inArray(table.id, ids)` на весь набор (у нас — до 5000 id «несвежих» нарядов и ~1600 двигателей каталога). Десктопный better-sqlite3 несёт современный SQLite с `SQLITE_MAX_VARIABLE_NUMBER=32766` и это глотает, а системный SQLite Android (через `@capacitor-community/sqlite`) живёт на **легаси-капе 999** → запрос падает, исключение всплывает как «ошибка загрузки». `syncService` этот кап учитывал (`IN_ARRAY_CHUNK`), а доменные сервисы — нет.
- **Диагностика:** ищи `inArray`/`IN (?…)` с массивом неограниченной длины на пути, который исполняется и на планшете. Признак — расхождение «десктоп ок / планшет нет» при одинаковых данных.
- **Лечение:** `collectChunked` (`electron-app/src/main/utils/sqlChunks.ts`) — гонит запрос порциями по 400 и склеивает строки. Порядок между чанками теряется, поэтому чанковать можно, когда сущность целиком попадает в один чанк (группировка per-entity не рвётся).
- **Правило:** любой запрос, который переезжает в мобильный порт, считай ограниченным 999 переменными; неограниченный `inArray` — потенциальный сбой ещё до первого запуска на устройстве.
- **Поймано:** 2026-08-08, жалоба владельца «список нарядов на планшете не грузится» (фикс — PR #504).

## M67 — весь экран становится белым: ленивая страница отрендерена без границы Suspense

- **Симптом:** оператор жмёт пункт UI (у нас — «⚙️ Настройки» в меню аккаунта), и приложение исчезает целиком: белый лист, корневой узел пуст, полосы вкладок нет. В консоли — `A component suspended while responding to synchronous input. This will cause the UI to be replaced with a loading indicator.` и React-стек «The above error occurred in one of your components: at Lazy».
- **Корень:** страница объявлена ленивой (`lazyPage` / `React.lazy`), а место её рендера НЕ обёрнуто в `React.Suspense`. Клик — синхронный ввод, поэтому React не может показать fallback и вместо этого сносит всё дерево. ErrorBoundary выше не спасает: ошибка приходит уже после размонтирования.
- **Диагностика:** сравни соседние ветки рендера. У нас в `shellV3/V3TabShell.tsx` ветки `list` и `card` были обёрнуты, а `chat` / `ai_chat` / `settings` — нет, при этом страница настроек ленивая. Воспроизводится только для вкладок, чей чанк ещё не загружен в этой сессии, — отсюда обманчивое «иногда работает».
- **Лечение:** обернуть КАЖДУЮ точку рендера ленивого компонента, а не полагаться на «где-то выше Suspense есть»: граница нужна между синхронным вводом и подвешенным компонентом.
- **Правило:** добавляешь ветку в switch рендера — посмотри, есть ли Suspense у соседних. Одна необёрнутая ветка = белый экран у оператора.
- **Поймано:** 2026-08-08 в R3-PR1. Баг жил на проде (v2026.808.1830): меню аккаунта → «Настройки».

## M68 — фича мертва месяцами, потому что её «страховка» указывает на снесённый класс

- **Симптом:** режим просто не работает у оператора, при полностью живом коде, зелёных тестах и без единой ошибки в логе. У нас — планшетный режим «данные на весь экран»: панели не убирались с 07.08, хотя вся механика была на месте.
- **Корень:** fail-open-проверка («нет ожидаемой разметки — выключаемся, а не ломаем экран») перечисляет якоря строками. Один якорь (`.mx-chrome-slot--header`) уехал вместе с переписанной шапкой в соседнем PR, и проверка честно отработала: через 2 с после монтирования поставила `broken = true`. Сброса у флага нет — режим выключался НАВСЕГДА, каждый запуск.
- **Почему не заметили:** страховка тем и опасна, что её срабатывание выглядит как штатная работа. Экран остаётся рабочим, ошибок нет, а `console.warn` в цеху никто не читает. Соседний якорь того же списка был жив — и на ревью список выглядел «поддерживаемым».
- **Диагностика:** грепни каждый строковый якорь по репо и посмотри, есть ли **рендерящий** его файл (не только CSS и не только сам список). Класс, который встречается лишь в конфиге и стилях, никто не ставит.
- **Лечение:** список якорей — в отдельный чистый модуль + тест с жёстким `toEqual`, плюс карта «якорь → файл, обязанный его ставить». **Мягкая проверка («список непустой», `toContain`) тут бесполезна:** пустой список — валидное значение для `filter(...).length === 0`, то есть конфигурация, которая выключает страховку насовсем, прошла бы зелёной.
- **Правило:** у любой строковой связки «код ↔ разметка» должен быть тест, который краснеет от переименования; проверять надо не «список выглядит осмысленно», а «каждый элемент кто-то ставит».
- **Поймано:** 2026-08-09, планшетный хвост R3 (дефект I). Соседний дефект J того же класса: список «контейнеров данных» из трёх классов содержал два снесённых — прокрутка любого списка не считалась данными.

## M69 — «идемпотентный» скрипт при повторном прогоне плодит дубликаты вместо пропуска

- **Симптом:** скрипт написан идемпотентно (`ensureX`: нашёл — вернул, не нашёл — создал), но второй прогон на той же базе не пропускает данные, а создаёт их заново. Счётчик сущностей растёт вместо того, чтобы стоять. У нас: `seedPortfolioDemo.ts` на повторном прогоне добавлял к 160 двигателям ещё сотню.
- **Корень:** значения генерирует ОДИН общий детерминированный PRNG на весь прогон, а ветки «создал» и «уже есть» потребляют РАЗНОЕ число его вызовов (ветка «уже есть» делает `continue` до генерации статусов). Первая итерация совпадает, дальше поток смещается — и ключ поиска (`engine_number`) на второй итерации уже другой, значит `ensureX` честно ничего не находит и создаёт новую строку. Детерминизм есть, воспроизводимости нет.
- **Диагностика:** сравни счётчик строк до и после повторного прогона (`select count(*)`), а не «скрипт отработал зелёным». Растёт — смотри, где ветвление пропускает вызовы генератора.
- **Лечение:** генератор **на каждую сущность**, засеянный её собственным ключом (`rngFor('engine:' + i)`), а не один на прогон. Тогда порядок и число вызовов внутри одной итерации не влияют на остальные, и любая ветка даёт те же значения.
- **Правило:** «детерминированный PRNG» ≠ «идемпотентный скрипт». Общий поток случайности связывает итерации между собой; как только у итераций появляются разные пути, воспроизводимость ломается молча.
- **Поймано:** 2026-08-10, сид демо-стенда портфолио.

## M70 — массовый серверный скрипт «зависает» без единого активного запроса в БД

- **Симптом:** скрипт с тысячами записей встаёт: прогресса нет минутами, при этом в `pg_stat_activity` ноль активных запросов, соединение висит в `idle in transaction` с `begin`. Похоже на дедлок в БД, но БД ни при чём.
- **Корень:** узкое место — **ledger**, а не PostgreSQL. Каждая запись идёт штатным sync-путём с подписью, а `LedgerStore` держит файловый лок (`.ledger.lock`) и переписывает `state.json` **целиком** на каждый append. При выросшем состоянии (у нас ~8 МБ) одна запись занимает секунды, и деградация квадратичная: чем больше писал, тем медленнее пишешь.
- **Усугубляющие факторы:** (1) параллельно живой клиент — его sync каждые ~15 с забирает тот же лок, и скрипт стоит в очереди; (2) осиротевший после таймаута инструмента процесс того же скрипта — два писателя блокируют друг друга, и оба выглядят «зависшими».
- **Диагностика:** посмотри `mtime` и размер `state.json` в `MATRICA_LEDGER_DIR` и возраст `.ledger.lock` (`{"pid":…,"ts":…}`). Лок держится десятками секунд одним writer'ом — это он. Проверь заодно, нет ли второго процесса скрипта.
- **Лечение:** одноразовому массовому скрипту — **отдельный `MATRICA_LEDGER_DIR`** (скопировав `server-key.json`/`data-key.json`), клиентов на время прогона остановить, следить, что скрипт запущен в одном экземпляре. Для рабочего контура — не гнать тысячи записей через ledger-путь без нужды.
- **Поймано:** 2026-08-10, сид демо-стенда портфолио (рецепт для PC40 — в `docs/machines/PC40.md`).

## M71 — клиент перестал получать ЛЮБЫЕ изменения: курсор pull'а встал на невидимом окне

- **Симптом:** `sync.run()` отвечает `ok:true`, но всегда `pulled: 0`, и `serverCursor` заметно меньше `serverLastSeq`. Данные на сервере есть (видно в PG), в реплике их нет и не будет; выглядит как «сервер молчит». В нашем случае ответ ИИваныча лежал в БД, а клиент бесконечно показывал «думает».
- **Корень:** приватность режет чужие строки **в SQL, до LIMIT**, поэтому окно изменений может целиком состоять из невидимых клиенту строк. Ответ тогда пустой, а `server_cursor` считался как «seq последней отданной строки, иначе прежний курсор» → курсор оставался на месте, следующий pull перечитывал то же невидимое окно, и всё, что приходило позже, до реплики уже не доезжало. Состояние **вечное**: само не рассасывается.
- **Диагностика:** `window.matrica.sync.run()` в CDP → сравнить `serverCursor` и `serverLastSeq`. Разрыв при `pulled: 0` на повторных прогонах = этот случай.
- **Лечение (исправлено 2026-08-10):** пустая страница двигает курсор на голову ledger'а — `nextPullCursor` в `pullChangesSince.ts` (юнит-тест `pullCursor.test.ts`). До фикса помогал только `sync.resetLocalDb()`.
- **Грабля внутри лечения:** прыгать на `serverLastSeq = max(ledger_tx_index, ledger)` **нельзя**. Seq новым строкам синк-таблиц раздаёт счётчик ledger'а, и на БД с дрейфом счётчиков (dev-снимок: индекс 657 104 против 623 199 по строкам) прыжок на общий максимум увёл бы курсор выше всех будущих записей — слепота стала бы постоянной. Прод дрейфа не имеет, но фикс всё равно считает по ledger'у.
- **Поймано:** 2026-08-10, приёмка прямого ИИваныча (D-024). Тот же корень стоит за старыми записями «dev-реплика застряла в push-петле, лечится fullPull» — это был симптом, а не причина.

## M72 — `fullPull` не лечит реплику, в которой осталась живой строка, удалённая на сервере

- **Симптом:** `sync.fullPull()` падает `SqliteError: UNIQUE constraint failed: …` (у нас — `erp_engine_assembly_bom_lines`), и после этого любой синк возвращает ту же ошибку. Реплика в тупике.
- **Корень:** `fullPull` **не чистит** локальную БД, а апсертит поверх. Если из-за застрявшего курсора (M71) реплика не получила удаление строки, а на сервере её место занял новый ряд с тем же естественным ключом, то живая старая строка и приезжающая новая сталкиваются на unique-индексе. Клиентские частичные unique (`WHERE deleted_at IS NULL`, миграция `0020_replica_not_stricter`) тут не спасают — конфликтуют две ЖИВЫЕ строки.
- **Лечение:** `sync.resetLocalDb()` (полная перезаливка), не `fullPull`. После сброса клиент перезапускается сам — dev-обёртка `pnpm --filter electron-app dev` при этом умирает вместе с vite, поднимать заново.
- **Поймано:** 2026-08-10, там же.

## M73 — после `git pull` на проде `tsc` оставляет старый `dist`, и рестарт поднимает прежний код

- **Симптом:** деплой прошёл «зелено» — `git pull` показал изменённые файлы, `pnpm -F backend-api build` отработал без ошибок, сервис перезапустился, `/health` отвечает. А поведение прежнее: добавленной строки лога нет, новой ветки кода не видно.
- **Диагностика:** сравнить `mtime` файла в `backend-api/dist/**` с временем деплоя и грепнуть в `dist` то, что добавляли в `src`. У нас `src` содержал `worker started`, а `dist` — нет, при `mtime` на семь минут раньше.
- **Корень:** сборка посчитала выход актуальным и файл не переписала (инкрементальное состояние tsc). Повторный `build` тем же кодом собрал файл правильно — то есть «успешный» первый прогон был пустым.
- **Лечение:** после деплоя backend'а **проверять факт, а не код возврата**: грепнуть в `dist` признак свежей правки либо сверить `mtime`. Не совпало — повторить build и рестарт.
- **Класс:** «зелёный шаг ≠ годный артефакт» (родственно #136 в пуле brain). Тот же урок, что с неподписанным APK.
- **Поймано:** 2026-08-10, раскатка прямого движка ИИваныча.

## M74 — планшет: первый полный pull детерминированно убивает приложение, «поздние» таблицы пусты

- **Симптом:** на Android-планшете после свежей установки часть списков наполняется (двигатели), а часть — навсегда пуста (наряды); sync то `syncing`, то `error: Failed to fetch`; приложение периодически перезапускается само. На десктопе тот же код работает.
- **Диагностика:** `adb logcat -d -b crash` → `java.lang.OutOfMemoryError` со стеком `org.json.JSONTokener … com.getcapacitor.MessageHandler.postMessage`. Это разбор JS→native вызова: Capacitor-мост парсит КАЖДЫЙ вызов плагина как один JSON-документ в Java-куче (лимит 256 МБ).
- **Корень:** `upsertPulledRowsInChunks` шлёт до 2000 строк одним INSERT (десктопный кап 32000 bind-параметров). Фолбэк на 900 срабатывает только если Android-SQLite успеет ответить «too many variables» — на жирных таблицах Java-парсер умирает от OOM раньше. Полный pull детерминированно гибнет на одном и том же месте: таблицы до него доезжают, после — никогда.
- **Лечение:** байтовый кап bridge-вызова, инжектируемый платформой: `setSyncSqlLimits({maxBindParams: 900, maxChunkBytes: 700_000})` в `wireSyncForAndroid` (`electron-app/src/main/services/sync/upsertChunks.ts`); `android:largeHeap="true"` как страховка.
- **Правило:** любой JS→native вызов Capacitor-моста считай ограниченным единицами мегабайт; пачку данных неограниченного размера режь по байтам, не только по числу строк/переменных (родня M66 — там кап переменных, тут кап кучи).
- **Поймано:** 2026-08-11, жалоба владельца «до сих пор на планшете не загружаются списки нарядов»; крэши в logcat 10.08 15:38 и 11.08 09:45 идентичны.

## M75 — нейросеть «постоянно возвращает ошибку», а токены у провайдера не тратятся

- **Симптом:** пользователь жалуется, что ИИваныч всегда отвечает ошибкой; в кабинете провайдера расход токенов нулевой, отчего кажется, что «подключения нет» и виноват ключ.
- **Диагностика (сначала — журнал, не ключ):** `journalctl -u matricarmz-backend-primary | grep -E "worker started|empty answer|ai log analysis failed"`. Строка старта печатает `provider`, `model` и `keyConfigured` — если там `true`, ключ на месте, и копать надо в форме запросов. Нулевой расход это не опровергает: отвергнутый запрос токенов не тратит.
- **Корень (два разных, оба дают «всегда ошибка»):**
  1. `400 Thinking mode does not support this tool_choice` — модели DeepSeek держатся в thinking-режиме, а он несовместим с принудительным `tool_choice: {type:'tool'}`. Все вызовы `callLlmJson` (разбор логов, чат, аналитика) падают на входе.
  2. `ai chat direct: empty answer {steps:N}` — цикл вызова инструментов упёрся в потолок шагов на очередном `tool_use` и вернул пустой текст. Пустой ответ уходит в эскалацию, после трёх попыток пользователь видит «Технический сбой движка».
- **Лечение (исправлено 2026-08-11, PR #537):** на deepseek инструмент просим текстом системного промпта, а не параметром (на Anthropic принуждение оставлено + общий откат на инструкцию по этой же 400-й); при исчерпании шагов делается один финальный вызов «дай ответ по собранным данным», инструкция дописывается блоком в ПОСЛЕДНЕЕ user-сообщение — два user-сообщения подряд эндпойнт не принимает.
- **Правило:** «ошибка + нулевой расход» — это чаще отвергнутый запрос, чем отсутствующий ключ. Ключ проверяется одной строкой журнала, дальше смотри текст ошибки провайдера.
- **Поймано:** 2026-08-11, жалоба владельца «токены на DeepSeek есть и не тратятся, возможно, токен неправильно взят из кармана».

## M76 — кнопка есть в разметке, но на планшете её физически не видно: `opacity: 0` до `:hover`

- **Симптом:** функция «не работает» только на планшете, хотя код общий и никаких платформенных гейтов на ней нет. У нас — закрепление кнопок меню: скрепка 📌 в DOM есть, обработчик есть, а нажать нечего.
- **Корень:** элемент показывается по наведению (`.row:hover .pin { opacity: 1 }` при базовом `opacity: 0`). На сенсорном экране события наведения нет вовсе, поэтому элемент остаётся прозрачным навсегда.
- **Лечение:** `@media (hover: none) { .pin { opacity: .55 } }` — показывать постоянно там, где наведения не существует.
- **Правило:** любой hover-only аффорданс (скрепки, «крестики», кнопки строк таблицы) на сенсорном клиенте = мёртвая функция. Проверять поиском `:hover` рядом с `opacity`/`visibility`/`display`, а не глазами на десктопе.
- **Поймано:** 2026-08-11, жалоба владельца «на планшете тоже нужно закреплять кнопки в меню».

## M77 — короткая метка из «последних цифр номера договора» схлопывает все ГОЗ-договоры заказчика в одну

- **Симптом:** в печатной форме у заказчика восемь разных договоров, а в колонке договора у всех одна и та же метка (`№ 25`). На синтетических фикстурах («125/2026») правило выглядело здоровым.
- **Корень:** боевые номера — ГОЗ-формата `<25-значный ИГК>/<номер>/ГОЗ-<год>`. Хвост номера это **маркер года**, общий на все договоры года; различает договоры сегмент ПЕРЕД ним. Правило «взять последние цифры» берёт ровно общую часть.
- **Диагностика:** выгрузи пары «полный номер → метка» по всем строкам отчёта и посмотри на уникальность **внутри заказчика**, а не в целом по выборке: по всей базе метки выглядят разными (у каждого заказчика свой год/номер), схлопывание видно только внутри блока.
- **Лечение (актуальное с 12.08.2026):** `shortContractSuffixLabel` (`shared/src/domain/contract.ts`) берёт **первый сегмент** номера (до первого «/») и его последние три цифры: `2325187913551442245231239/739-1/55/…` → `*239`. Различающая часть ГОЗ-номера сидит именно в ИГК, поэтому разведение по «глубине хвоста» больше не нужно; та же метка печатается в нарядах (одна звёздочка, не три — решение владельца 12.08). Полный номер печатается рядом мелким шрифтом, поэтому редкое совпадение трёх цифр читателя не путает.
- **Было до 12.08.2026:** `shortContractLabel` отбрасывал хвостовые `ГОЗ-NN`/год и брал последний значащий сегмент, а совпавшие внутри заказчика метки билдер разводил, беря на сегмент больше (`9012/2325` vs `8947/2325`). Владелец попросил единое правило с нарядами — функция удалена.
- **Правило:** прежде чем ужимать пользовательский идентификатор до «хвоста», посмотри на реальные значения — в ГОЗ-номерах, инвентарных и складских кодах хвост обычно общий (год, тип, склад), а различающая часть сидит в середине.
- **Поймано:** 2026-08-12, e2e-смоук отчёта «Движение двигателей по заказчикам» на dev-реплике (PR #548). Unit-тесты на синтетике проблему не видели.

## M78 — вкладка переключилась, но прежняя панель осталась на экране: инлайновый `display` перебивает `hidden`

- **Симптом:** карточку разложили по вкладкам по образцу соседних (`<div data-card-tab="x" hidden={active !== 'x'}>`), клик по вкладке меняет подсветку, но на экране одновременно видны две панели — или «скрытая» панель продолжает занимать высоту и тянет скролл.
- **Корень:** атрибут `hidden` — это правило UA-стилей `[hidden] { display: none }`, самая слабая специфичность. Любой **инлайновый** `style={{ display: 'grid' | 'flex' }}` на том же узле его перебивает. В карточках, где панель сама была раскладочным контейнером (у номенклатуры блоки шли `display: grid`), достаточно повесить `hidden` на тот же div — и скрытие молча не работает.
- **Диагностика:** `el.hidden` вернёт `true` при живом блоке — проверять надо **фактическую** геометрию: `el.getBoundingClientRect().height`. Смоук, который смотрит только на атрибут, зелёный на сломанной вкладке.
- **Лечение:** панель-обёртка **без инлайнового `display`**; раскладку либо переносить внутрь дочернего блока, либо включать условно: `style={{ gap: 12, ...(active === 'x' ? { display: 'grid' } : {}) }}` (условный спред — из-за `exactOptionalPropertyTypes` присвоить `display: undefined` нельзя).
- **Правило для смоуков вкладок:** проверять пару «`hidden === true` **и** `height === 0`», а не один атрибут. Готовый драйвер — `.verifier-electron/_nomenclature-tabs-smoke.mjs`.
- **Поймано:** 2026-08-13, разбор карточки номенклатуры по вкладкам — поймано на этапе правки, до прогона, потому что образец (`EmployeeDetailsPage`) вешал `hidden` на «голый» div, а здесь блок нёс свою раскладку.

## M79 — массовая запись через `setEntityAttribute` встаёт намертво: ledger-append на каждое значение

- **Симптом:** серверный скрипт, пишущий много EAV-значений, ползёт со скоростью порядка одной сущности в минуту, а на нагруженной машине падает `terminate called after throwing an instance of 'std::bad_alloc'`. На малых объёмах (десятки значений) тот же код отрабатывает мгновенно, поэтому на dev проблема не видна.
- **Корень:** `setEntityAttribute` → `recordSyncChanges` → `signAndAppendDetailed` — **ledger-append на КАЖДОЕ значение**, а append переписывает `state.json` целиком. На проде 2026-08-13 файл весил **164 МБ**: одна карточка двигателя (~15 атрибутов) стоила ~2,5 ГБ дискового ввода-вывода. Замер — 27 значений за 25 минут.
- **Диагностика:** `du -sh $MATRICA_LEDGER_DIR` и размер `state.json`; если он десятки-сотни мегабайт, любая массовая запись поатрибутным путём безнадёжна. Второй признак — ровный темп «N значений в минуту», не зависящий от сложности данных.
- **Лечение:** писать пакетами через `recordSyncChanges(actor, changes[], opts)` — `writeSyncChanges` делает **ровно один** append на весь переданный массив и сам проецирует в PG (`syncWriteService.ts`, шаги 1–3). Чанки по 400–1000 строк. Стало 15 append'ов вместо ~26 000.
- **Три обязательных детали пакетного пути:**
  1. **`entities` пишутся до `attribute_values`** — у значений FK на сущность.
  2. **id существующего значения переиспользуется** — на паре `(entity_id, attribute_def_id)` висит unique-индекс; новый id даст конфликт вместо обновления.
  3. **Обрыв между шагами плодит двойников:** карточка без единого атрибута не имеет номера, следующий заход её не найдёт и заведёт сущность заново (на проде так набежало 235 пустых карточек). Уборка — мягкое удаление тем же sync-путём, плюс скрипт обязан **пропускать уже совпадающие значения**, иначе каждый повторный запуск начинает с нуля и умирает на том же месте.
- **Поймано:** 2026-08-13, импорт учётной таблицы двигателей (1731 строка, ~15 тыс. значений) — [`plans/engine-import-2026-08-13.md`](plans/engine-import-2026-08-13.md).

## M80 — сгенерированный `.docx` «испорчен» в Word 2007, хотя zip валиден

- **Симптом:** файл скачивается, `unzip -t` без ошибок, `file` говорит «Microsoft Word 2007+», все XML-части парсятся — а Word при открытии выдаёт «Файл поврежден» либо «Недопустимый знак xml». sha256 на сервере и у клиента совпадают, то есть транспорт ни при чём.
- **Корень (три независимых причины, каждая валит файл ЦЕЛИКОМ, а не только свой абзац):**
  1. **Ширина таблицы в процентах** — `w:tblW w:type="pct" w:w="100%"` (в библиотеке `docx` это `WidthType.PERCENTAGE`). Word 2007 такую запись не понимает. Лечение: только твипы, `WidthType.DXA`; полоса набора A4 = `11906 − 1440 − 1440 = 9026`.
  2. **`<w:tbl>` без строк** — получается, если markdown-таблица состояла из одной строки-разделителя (`| --- | --- |`) и парсер её отфильтровал. Лечение: не создавать таблицу с нулём строк.
  3. **Управляющие символы и непарные суррогаты в тексте** — недопустимы в XML 1.0; изредка приезжают в ответе LLM (обрубленный эмодзи, байты 0x07/0x1F). Лечение: вычищать текст перед вставкой в документ (см. M82 про то, как такую регулярку писать).
- **Диагностика (важнее самого фикса):** проверка zip и парсинг XML **ничего не доказывают** — валидировать надо тем самым потребителем. На Windows это одна команда через COM, Word показывать не обязательно:
  ```powershell
  $w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0
  try { $d = $w.Documents.Open($path, $false, $true); "OK " + $d.Paragraphs.Count; $d.Close(0) }
  catch { "FAIL " + $_.Exception.Message }
  $w.Quit()
  ```
  Дальше — бисекция: генерировать варианты по одному признаку (только абзацы → +заголовок → +список → +таблица в pct → +таблица в dxa) и смотреть, на каком открытие ломается.
- **Профилактика:** регрессии закреплены тестами, которые распаковывают собранный `.docx` и проверяют `w:type="dxa"` вместо `pct`, отсутствие пустых `<w:tbl>` и вычистку управляющих символов (`backend-api/src/services/ai/answerDocument.test.ts`). Версия Word у операторов — **2007**, ориентироваться на неё, а не на свежий Office.
- **Поймано:** 2026-08-17, Word-вложение к ответам ИИваныча ([#607](https://github.com/Valstan/MatricaRMZ/pull/607)).

## M81 — `TLS handshake timeout` у Go-клиента при полностью живом сервере

- **Симптом:** Заглушка-обновлятор (Go) три попытки подряд падает `net/http: TLS handshake timeout`, при этом сервер отвечает: `/health` 200, оба сервиса active, с самого VPS хендшейк 5 мс.
- **Корень:** заводская/офисная сеть душит TLS к нашему VPS — рукопожатие снаружи стабильно занимает **~12,5 с** (TCP-коннект при этом 1 мс, то есть тормозит не сервер, а промежуточный узел). Дефолтный `TLSHandshakeTimeout` в Go — **10 с**, поэтому отказ детерминированный, а не «моргнула сеть».
- **Диагностика:** `curl -w 'tcp %{time_connect}s | tls %{time_appconnect}s | total %{time_total}s'` снаружи и с самого сервера. Расхождение «снаружи 12 с / внутри 5 мс» = DPI по пути, сервер невиновен.
- **Лечение:** явный транспорт с запасом — `&http.Transport{TLSHandshakeTimeout: 60 * time.Second}`, таймаут запроса плана 90 с. Дефолты Go рассчитаны на нормальную сеть, у нас её нет.
- **Смежное:** через VPN у владельца тот же путь давал `EOF` на скачивании 130 МБ, пока сервер отдавал `http://`-ссылку ([#603](https://github.com/Valstan/MatricaRMZ/pull/603)): порт-форвардер хостера терминирует TLS и присылает `X-Forwarded-Proto: https`, а nginx перетирал заголовок на `$scheme` (=http). Клиенты Android cleartext режут вовсе.
- **Поймано:** 2026-08-17 ([#601](https://github.com/Valstan/MatricaRMZ/pull/601)); увидено только потому, что Заглушка научилась печатать ход работы в консоль.

## M82 — литеральные управляющие символы в исходнике не выживают при правке инструментами

- **Симптом:** пишешь в коде класс символов с управляющими байтами (0x00–0x1F) — а после правки файла инструментами в нём оказываются **настоящие** управляющие байты (`grep` начинает говорить «Binary file matches») либо, наоборот, они молча теряются. Каскад следствий: eslint ругается `no-irregular-whitespace` / `no-control-regex`, тест `expect(xml).not.toMatch(CONTROL_CHARS_RE)` падает на обычном пробеле (класс после потери байтов вырождается в диапазон из пробела и дефиса), а попытка переписать файл питоном валится `UnicodeEncodeError: surrogates not allowed`, если среди символов был непарный суррогат — и файл остаётся **обнулённым**.
- **Корень:** инструменты правки файлов нормализуют `\uXXXX` ↔ сам символ, и часть управляющих символов при этом не выживает. Один и тот же исходник после двух правок означает разное.
- **Лечение:** не держать в исходниках ни литеральных управляющих символов, ни `\uXXXX`-escape'ов в регулярках, которые будут правиться инструментами. Собирать класс символов **программно из ASCII-текста**:
  ```ts
  // eslint-disable-next-line no-control-regex -- ровно эти символы мы и вырезаем
  const XML_CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');
  ```
  в тестах вместо литерала — `String.fromCharCode(7)`. Если правишь файл скриптом, собери escape-последовательность из `chr(92) + 'u0000'`, а перед записью проверь, что реальных управляющих байтов в тексте не осталось — проверка в одну строку ловит рецидив сразу.
- **Правка файла питоном:** `io.open(..., encoding='utf-8', newline='')` и никаких исключений посреди `write` — упавший на середине скрипт оставляет пустой файл (так и случилось, файл пришлось писать заново).
- **Поймано:** 2026-08-17, вычистка XML-небезопасных символов в Word-вложении.

## M83 — ИИваныч докладывает удалённые записи как живые данные учёта

- **Симптом:** в ответе появляется «в справочнике есть дубль этого же договора с тем же номером — id `a484dee6…`». Владелец идёт разбираться с дублем, а его нет: запись **удалена** ещё за пять месяцев до вопроса, живых ссылок на неё ноль, в учёте она не участвует.
- **Корень:** удаление в базе **мягкое** (`deleted_at`), а `execute_safe_sql` даёт модели писать произвольный SELECT и не навязывает `deleted_at is null`. Гейт у tool'а есть, но он про другое — только «это SELECT» + `LIMIT 200`. Штатные tools (`find_entity` и пр.) фильтруют tombstone'ы сами, поэтому дефект виден **только** на самостоятельном SQL.
- **Почему опасно именно это:** ответ звучит как факт о состоянии учёта и выглядит правдоподобно. Отличить «дубль есть» от «дубль был и убран» по тексту ответа нельзя — владелец не может перепроверить, не залезая в базу.
- **Лечение:** правило вписано прямо в description `execute_safe_sql` (`⚠️ ОБЯЗАТЕЛЬНО … deleted_at is null` на каждую таблицу, с этим самым кейсом в качестве примера). Description — не документация, а часть промпта: модель читает его каждый вызов.
- **Мораль шире одного tool'а:** давая модели произвольный SQL, приходится переносить в промпт **все** неявные инварианты схемы, которые в типизированных tools зашиты кодом. Мягкое удаление — первый такой инвариант; за ним пойдут права и мультиарендность.
- **Поймано:** 2026-08-17, вопрос владельца «что за дубль договора, откуда он взялся».

## M84 — нечёткий поиск вытесняет точное совпадение: длинный номер проигрывает короткому похожему

- **Симптом:** «дай сводку по договору 425» → «поиск не дал совпадений (0 строк)», а нечёткий добрал только двигатели `Ф07АТ2425`, `Х07АТ4250`. Договор при этом в базе есть.
- **Два независимых корня**, и лечить надо оба:
  1. **Искали не в тех атрибутах.** `find_entity` смотрел только `name/full_name/short_name/engine_number/login`. У договора атрибута `name` **нет вовсе** — он опознаётся `number` / `internal_number`, а их в списке не было: номер договора не искался ни одним tool'ом.
  2. **Сортировка ставила нечёткое выше точного.** `order by score desc`, где `score = similarity()`. У длинного номера (`…5215425/641/25/…`) вхождение подстроки точное, но similarity ≈ **0.05** — триграммная близость падает с длиной строки; у короткого `Ф07АТ2425` она ≈ 0.17. Точное попадание вылетало за `limit`, оставляя в выдаче один мусор.
- **Лечение:** список атрибутов вынесен в `SEARCHABLE_IDENTIFIER_CODES` (номера, табельный, клеймо, `goz_name`) — но не «все текстовые», иначе в кандидаты полезут комментарии и реквизиты счетов; сортировка стала `order by exact_hit desc, score desc`.
- **Мораль:** `similarity()` — метрика похожести, а не релевантности, и она **зависит от длины**. Смешивать точный и нечёткий поиск в одном `ORDER BY` по одному score нельзя: точное совпадение должно быть отдельным, старшим ключом сортировки.
- **Поймано:** 2026-08-17, приёмка ИИваныча владельцем.

## M85 — rsyslog «active», но не пишет ничего: файл правил забит нулями

- **Симптом:** `/var/log/auth.log` — **0 байт с mtime трёхмесячной давности**, при этом `systemctl is-active rsyslog` = `active`, `is-enabled` = `enabled`, в journald всё есть. Durable audit-trail SSH-входов отсутствует, и заметно это только когда он понадобился (у нас — при попытке установить владельца осиротевшего ключа).
- **Корень:** `/etc/rsyslog.d/50-default.conf` — **1127 байт `NUL`** (тот же паттерн хостера с обнулением конфигов, память `prod-config-corruption-pattern`). Именно этот файл несёт правила `auth,authpriv.* → /var/log/auth.log` и `*.* → /var/log/syslog`. rsyslog грузит его, не видит ни одного правила и честно пишет никуда.
- **Почему диагностика уводит в сторону:** `file /etc/rsyslog.conf` отвечает `ASCII text` — но это **не тот файл**, правила лежат в `rsyslog.d/`. `ls -la` показывает нормальный размер (нули — тоже байты). Единственный быстрый признак: **`sudo ls -l /proc/$(pgrep -x rsyslogd)/fd | grep -c log$` = 0** — демон жив, но ни одного лог-файла не держит открытым. После починки там 2.
- **Лечение:** пакет держит эталон в `/usr/share/rsyslog/50-default.conf` (в `dpkg -S` файл из `/etc/rsyslog.d/` **не ищется** — он не conffile, а копия шаблона при установке). `sudo install -m 644 /usr/share/rsyslog/50-default.conf /etc/rsyslog.d/50-default.conf` → `systemctl restart rsyslog`. Восстановленный контент не воспроизводит локальные правки, если они были: из нулей их не достать. Скачать `.deb` заново для этого НЕ нужно (и `apt-get download` на этой машине отдаёт 404 по устаревшему индексу).
- **Проверять боем:** сделать новый SSH-вход и убедиться, что `Accepted publickey … SHA256:…` появился в `auth.log`, а не полагаться на «сервис перезапустился».
- **Поймано:** 2026-08-17.

## M86 — `sudo find | while read f; do … < "$f"` даёт ЛОЖНЫЕ срабатывания на root-only файлах

- **Симптом:** скан «какие файлы в `/etc` забиты нулями» отрапортовал побитыми `/etc/ufw/*.rules` и `/etc/sudoers.d/*` — то есть firewall и sudo-правила. Оба были целы.
- **Корень:** `sudo` применён только к `find`. Перенаправление `< "$f"` раскрывает **непривилегированный** shell, поэтому на root-only файле оно падает `Permission denied`, команда получает **пустой ввод**, и проверка «после вырезания `NUL` осталось 0 байт» срабатывает на пустоте. Отсутствие прав неотличимо от «файл состоит из нулей».
- **Признак в выводе:** для одного и того же пути рядом стоят и вердикт, и `Permission denied`. Если бы вердикты печатались без stderr — ложь прошла бы незамеченной.
- **Лечение:** заворачивать **весь конвейер**, а не только `find`: `sudo sh -c 'find … | while read f; do … done'`. И вообще: любая проверка, где «пусто» и «не смог прочитать» дают один результат, обязана различать эти случаи явно (проверять код возврата чтения).
- **Мораль:** прежде чем доложить «у вас побит firewall», перечитай, от чьего имени читался файл. Ложная тревога о развале защиты дороже пропущенного файла.
- **Поймано:** 2026-08-17, при разборе обнуления конфигов на проде.

## M87 — ночной бэкап падает `UNIQUE constraint failed` и не создаётся вовсе

- **Симптом:** `backup:nightly` пишет `ошибка: SqliteError: UNIQUE constraint failed: entity_types.code` и завершается. Ни `.dump.enc`, ни `.sqlite` на Яндекс.Диск не уходят — падение происходит **до обеих выгрузок**. В БД при этом дублей нет: `SELECT code FROM entity_types GROUP BY code HAVING count(*)>1` пуст.
- **Корень:** предыдущий прогон был убит на середине (оборвался SSH, OOM, ребут) и оставил наполовину заполненный `/tmp/matricarmz_backups/YYYY-MM-DD.sqlite`. `new Database(path)` в better-sqlite3 **открывает существующий файл**, а не заменяет его, поэтому следующий прогон вставляет строки поверх уже вставленных и умирает на первом же UNIQUE-индексе. Блок `finally` подчищает temp-файлы — но убитый процесс до него не доходит.
- **Коварство:** ломается **навсегда**, а не разово. Пока файл лежит, каждая ночь даёт то же падение, и единственный симптом — строка в логе, который никто не читает. Похоже на «поехали данные в проде», хотя данные ни при чём.
- **Диагностика:** `ls -la /tmp/matricarmz_backups/` до запуска. Файл сегодняшней даты, оставшийся от прошлого прогона, — и есть причина.
- **Лечение:** `rm` файла (плюс `-wal`/`-shm`) снимает симптом немедленно. В коде закрыто: `buildSqliteSnapshot` сносит целевой файл перед созданием.
- **Мораль:** «временный» файл с предсказуемым именем + библиотека, которая открывает вместо перезаписи, = мина замедленного действия. Любой шаг, который может быть убит снаружи, обязан начинать с уборки за собой, а не заканчивать ею.
- **Поймано:** 2026-08-19, при первом боевом прогоне шифрованного бэкапа (обрыв SSH на проде).

## M88 — вложения двигателя видны в карточке, но скачивание отдаёт 403

- **Симптом:** оператор с `engines.view` открывает карточку двигателя, вкладка «Фото и документы» показывает список файлов и даже принимает новые загрузки, но `GET /files/:id` и превью отвечают 403. У остальных справочников то же вложение открывается нормально.
- **Корень:** запрос в EAV-ветке `computeFileAccess` (`backend-api/src/services/fileAccessService.ts`) джойнится на `attribute_defs` и получает фильтр `isNull(attributeDefs.deletedAt)` — по образцу почти всего остального репозитория (`electron-app/src/main/services/entityService.ts:30`, `backend-api/src/services/adminMasterdataService.ts:220` и ещё с десяток мест). Но **мягко удалённый def при живых значениях — штатное состояние**, а не поломка: `deleteAttributeDef(deleteValues=false)` и `deleteEntityType(deleteDefs=true, deleteEntities=false)` гасят определение и оставляют значения. Сам он не воскресает: уникальный индекс `attribute_defs_type_code_uq` по `(entity_type_id, code)` не частичный, поэтому пара занята удалённой строкой, а `ensureAttrDef` находит её и `deletedAt` не сбрасывает.
- **Коварство:** бьёт ровно по одному экрану и мимо ручной проверки по справочникам проходит незамеченным. Карточка двигателя — **единственная**, кто читает карту def'ов без фильтра удалённых (`electron-app/src/main/services/engineService.ts:51`), поэтому продолжает показывать и писать файлы; у остальных типов удалённый def отсекается на чтении, и «законного доступа» там просто нет.
- **Диагностика:** `select ad.code, ad.deleted_at from attribute_defs ad join entity_types et on et.id=ad.entity_type_id where et.code='engine' and ad.code='attachments'`. Непустой `deleted_at` при живых `attribute_values` — оно.
- **Лечение:** не ставить фильтр по `attributeDefs.deletedAt` в проверке доступа к файлу (в коде есть комментарий именно об этом). Разово воскресить def можно, открыв двигатель в web-админке — `upsertAttributeDef` сбрасывает `deletedAt`.
- **Мораль:** привычный по всему репозиторию фильтр «живых» строк в **авторизации** меняет смысл: там, где в UI он прячет устаревшее поле, в проверке доступа он отбирает права. Прежде чем копировать `isNull(deletedAt)` в гейт, спроси, что означает удалённая строка для этого конкретного решения.
- **Поймано:** 2026-08-21, скептиком-агентом при переводе EAV-ветки доступа к файлам на allow-list — до того, как фильтр попал в код.

## M89 — причесали подписи в отчёте, и подытоги схлопнулись в одну строку

- **Симптом:** после замены идентификатора в фолбэке на человеческую подпись («(не указано)», «(без названия)», «(склад не указан)») строки отчёта выглядят правильно, но блок подытогов схлопывается: вместо шести складов одна строка «Итого», вместо четырёх подразделений — одно. Числа при этом верны по сумме и неверны по разрезу — самый неприятный вид ошибки, потому что отчёт не падает и выглядит опрятнее прежнего.
- **Корень:** в этих отчётах **ключом группировки служит печатный текст колонки**, а не идентификатор: `const groupKey = normalizeText(row.departmentName, '(не указано)')` (`electron-app/src/main/services/reports/presets/catalogs.ts`), `totalsByWarehouse.set(warehouseLabel, …)` (`presets/warehouse.ts`, оборотная ведомость). Пока фолбэком стоял id, ключ был уникален для каждого объекта; общая подпись отсутствия делает его одинаковым для всех безымянных.
- **Коварство:** правка выглядит чисто косметической и проходит все гейты — типы, линт, юнит-тесты. Проявляется только на данных, где у нескольких объектов нет названия, то есть чаще на проде, чем на фикстурах.
- **Тот же класс, второй симптом:** подпись используется ключом СОПОСТАВЛЕНИЯ в фильтре (`brandFilterNamesLc` в `presets/workOrders.ts` сравнивает марку по тексту) — тогда выбор одной безымянной марки притягивает наряды всех остальных.
- **Диагностика:** прежде чем менять значение, которое печатается, грепнуть по ключу колонки в билдере: используется ли оно в `Map.set/get`, `groupKey`, `Set`, `includes`, `localeCompare`-сортировке. Если да — подпись менять нельзя, не разведя показ и ключ.
- **Лечение:** либо оставить идентификатор в фолбэке (с комментарием, почему), либо завести отдельный ключ группировки от id и показывать подпись только в ячейке. В `presets/{catalogs,warehouse}.ts` выбран первый вариант с комментарием в коде; второй — отдельная задача.
- **Мораль:** «сделать текст человечнее» — правка данных, а не оформления, если этот текст где-то работает ключом. Гейты такое не ловят: подытоги никем не проверяются.
- **Поймано:** 2026-08-21, ревью-агентом на этапе A PR II — трижды в одном PR, уже после того как правило было сформулировано.

## M90 — действие из панели МЕНЮ считает исход от устаревшего стола: скрытая keep-alive вкладка держит стейл-колбэки

- **Симптом:** тумблер галстука на вкладке убрал ярлык в корзину, следом «Добавить на Рабочий стол» из контекстного меню кнопки МЕНЮ сказал «добавлен» — а на сервере ярлык остался в корзине; либо наоборот, действие из меню молча возвращает стол к состоянию минутной давности. Воспроизводится только CDP-драйвером (он шлёт события в скрытую панель); оператор руками нажимает в видимую.
- **Корень:** панель МЕНЮ смонтирована дважды — в оверлее (перерисовывается каждый рендер) и в теле вкладки МЕНЮ, которую keep-alive держит в DOM через `FrozenWhileHidden` (`V3TabShell.tsx`, `React.memo` с `!prev.active && !next.active`). Скрытая копия **не перерисовывается**, её пропсы-колбэки — из последнего рендера, когда вкладка была активна; обработчик вида `const r = f(desktopUi); setDesktopUi(r.desktop)` считает исход от того снимка и **целиком заменяет** состояние устаревшим.
- **Лечение:** обработчики, которые «читают состояние → считают исход → пишут целиком», читают из ref-зеркала, которое обновляет сам App на каждом рендере (`desktopUiRef.current = desktopUi`), — ref не замораживается вместе с поддеревом. Альтернатива — функциональный `setState(prev => …)`, но тогда исход для сообщения оператору приходится вытаскивать отдельно.
- **Диагностика:** два одинаковых действия подряд: свежий колбэк на втором скажет «уже есть», стейл — снова «добавлен». В CDP-смоуке целиться только в **видимую** панель (`getBoundingClientRect()` > 0) — `document.querySelector('.v2-button-panel')` находит скрытую копию первой.
- **Поймано:** 2026-08-23, смоук этапа B (кнопка-галстук), шаг 4.

## M91 — `vitest run` висит без единой строки вывода: это бесконечный цикл в тестируемом коде, а не перегруз

- **Симптом:** `corepack pnpm -F <пакет> exec vitest run <файл>` не печатает даже шапку `RUN v4.x`, висит до таймаута; повторный запуск ведёт себя так же. В `Get-Process node` виден процесс с растущим CPU (сотни секунд). Каждый повтор добавляет ещё один такой процесс — они не умирают вместе с оборванной командой.
- **Корень:** тест дошёл до функции с бесконечным циклом и не может выйти, поэтому репортер не успевает напечатать ни строчки. Классический источник — поиск «первого подходящего места» с условием, которое при некоторых входах не выполняется НИКОГДА: `for (let row = 0; ; row++) for (let col = 0; col + cells <= cols; col++) …` крутится вечно, если `cells > cols` (внутренний цикл не выполняется ни разу). Поймано на раскладке Рабочего стола: плитка в две ячейки при столе в одну колонку.
- **Диагностика:** отличать от перегруза по CPU. Перегруженная машина даёт **красный** результат и печатает вывод (AGENTS.md §Autonomy); зависший цикл не печатает **ничего**. Смотреть `Get-Process node | Where CPU -gt 50` — спиннер виден сразу. Дальше читать сам код на предмет цикла без гарантированного выхода: `while (true)`, `for (;;)`, рекурсия без базы.
- **Лечение:** убить зависшие процессы по PID (оборванная команда их не снимает), починить цикл и **оставить тест на этот вход** — он и есть регрессия. В раскладке лечение — зажать запрос по ширине стола (`Math.min(cells, cols)`).
- **Поймано:** 2026-08-25, этап C Рабочего стола (`desktopLayoutGrid`).

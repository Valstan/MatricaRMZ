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
| M7 | Прод-конфиг (sshd/nginx/systemd) ведёт себя странно, «забит нулями» | прод / myjino |
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

---

## M1 — SSH-таймаут к проду
- **Симптом:** `ssh matricarmz` → `Connection timed out` или `banner exchange`, при этом `ping a6fd55b8e0ae.vps.myjino.ru` отвечает мгновенно.
- **Корень (по частоте):** (1) неверный порт — внешний **49217**, myjino форвардит `49217 → 49412` (внутренний; коннект на 49412 извне = таймаут); (2) нет `IdentitiesOnly yes` → ssh перебирает все ключи → fail2ban банит IP (тогда даже верный порт TCP-filtered).
- **Диагностика → лечение:** проверять в порядке **порт → ключ/`IdentitiesOnly` → fail2ban**. `~/.ssh/config` блок `Host matricarmz`: `Port 49217` + `IdentitiesOnly yes` + dedicated key. Бан снимается в myjino-панели (`fail2ban-client unban <IP>`). **Не долбить** логином при ошибке. Всегда `-o ConnectTimeout=15`. Транзиентный TCP-таймаут (после успешных вызовов) — одна повторная попытка, не цикл.

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
- **Лечение:** качать `.blockmap` **отдельным** `--pattern '*.blockmap'` (см. `CLAUDE.md` §Release process — скачивать все три артефакта).

## M6 — серверный скрипт пишет в sync-таблицу, но клиент не получает
- **Симптом:** maintenance-скрипт изменил данные на проде, но клиенты не видят их при инкрементальном `/sync`.
- **Корень:** запись в обход `recordSyncChanges` не получает `last_server_seq` → `pullChangesSince` её не отдаёт. Плюс: presence-FK актора (нужен реальный employee) и stale-seq guard (`allowSyncConflicts`).
- **Лечение:** писать через ledger-путь (`recordSyncChanges`/`insertChangeLog`); в скрипте — реальный employee-актор + `allowSyncConflicts`. См. memory `server_script_sync_write_gotchas`.
- **Подтверждено + усилено 2026-06-18 (#6 WS-A2):** с актором `system` (НЕ реальный employee) `recordSyncChanges` **тихо проецирует 0 строк в PG** (`writeSyncChanges` → `applyPushBatch` `dbApplied=0, skipped=[]`), НО Step-1/3 (ledger sign+append + `ledger_tx_index`) **всё равно отрабатывают** → дрифт: ledger/index держат новое значение со свежим seq, PG — старое с `last_server_seq=null`. Инкрементальный pull (читает PG `last_server_seq>since`) НЕ отдаёт (seq null), а cold/`replayLedgerToDb` — отдаст → split-brain. **Сигнатура:** скрипт рапортует «применено N», но re-dry-run показывает те же N; `ledger_tx_index` для row_id имеет свежий seq, а PG `last_server_seq=null`/значение старое. **Грепай M6 ДО починки.** **Восстановление-вперёд:** `UPDATE … SET col, last_server_seq FROM (ledger_tx_index latest per row_id)` — проекция ledger→PG без нового append (учти глобально-уникальные индексы + intra-batch дубли). Либо повторить запись с **реальным employee-актором**.

## M7 — прод-конфиг «забит нулями»
- **Симптом:** странные отказы сервисов/sshd/nginx на myjino VPS без видимой причины.
- **Корень:** на myjino системные конфиги периодически забиваются нулями (баг хостинга).
- **Диагностика:** `file <path>` (покажет `data`/нулевой размер вместо текста). См. memory `prod_config_corruption`.

## M8 — setEntityAttribute не долетает инкрементально
- **Симптом:** атрибут, записанный через `setEntityAttribute` (напр. `department_id`), не приходит клиенту инкрементальным pull — только после полного `sync.fullPull`.
- **Корень:** часть EAV-записей вне ledger-delta → incremental не несёт их.
- **Лечение:** если поле должно доезжать инкрементально — провести через sync-путь; иначе помнить, что нужен fullPull (актуально для seed/fixtures verify).

## M9 — /updates/status через secondary отдаёт старую версию
- **Симптом:** после деплоя `/updates/status` (через secondary) показывает прошлую версию или `infoHash:null`.
- **Корень:** `updateTorrentService` читает updates-dir в in-memory state **при старте** и пере-сканит редко. Рестарт при старом installer в dir → старое состояние до следующего скана.
- **Лечение:** готовить **все** артефакты updater'а (`*.exe`/`latest.yml`/`*.blockmap` + `ledger-publish`) **до** рестарта (см. `CLAUDE.md` §Release «Why download + ledger-publish go before restart»). Транзиентный `stale_manifest` на старте secondary самолечится интервал-сканом.
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

## M16 — `corepack pnpm install` на проде висит часами (electron-postinstall)
- **Симптом:** при прод-деплое `corepack pnpm install` (нефильтрованный) не завершается; в `ps` висят зомби-процессы `corepack pnpm install` с огромным etimes (часы/дни). Несколько параллельных деплоев усугубляют (борьба за pnpm store-lock).
- **Корень:** нефильтрованный install ставит **все 6 workspace'ов**, включая `electron-app`, чей postinstall (electron-бинарь download / native better-sqlite3 build с `buildDependenciesFromSource`) виснет на VPS. Прод-клиент `.exe` собирается GitHub Actions — на проде electron-app **не нужен**.
- **Лечение:** для **code-only** релиза (lockfile не менялся — «Already up to date») **пропустить install, собрать только серверные пакеты:** `corepack pnpm -F @matricarmz/shared -F @matricarmz/backend-api -F @matricarmz/web-admin build` (deps уже на месте). Зомби-install'ы убить (`pkill -9 -f 'corepack pnpm install'`, НЕ трогая `dist/index.js`-сервисы). Если install реально нужен (новые deps) — фильтровать `--filter '!@matricarmz/electron-app'` или `--ignore-scripts`. Релиз сериализовать (не внахлёст).

## M17 — кнопка в UI есть, но серверный ledger-гейт режет запись (UI ↔ server parity)
- **Симптом:** оператор видит кнопку «Добавить/редактировать», правит и локально сохраняется, но изменения не доезжают на сервер; в критсобытиях (`backend-api/logs/critical-events.ndjson`) — `server.authz.denied` `forbidden:<entityType>`, оффлайн-очередь синка ретраит бесконечно (шум каждые ~2 мин).
- **Корень:** авторизация в ДВА независимых слоя. (1) UI-гейт — `deriveUiCaps` → `caps.*` в `App.tsx` решает, показать ли кнопку. (2) Серверный ledger write-гейт — `shared/src/domain/ledgerAuthz.ts` `ENTITY_TYPE_REQUIREMENT` (резолвится в `partitionLedgerInputsByAuthz`) решает, принять ли sync-запись. Если они на РАЗНЫХ правах — кнопка показана, а запись режется. Частный случай: тип помечен `kind:'admin'`/`'superadmin'` → `operatorMeetsRequirement` для operator-ролей ВСЕГДА `false`, сколько ни выдавай permission-оверрайдов.
- **Диагностика:** взять `<type>` из `forbidden:<type>` → грепнуть в `ledgerAuthz.ts ENTITY_TYPE_REQUIREMENT` → сверить требуемое право с UI-гейтом этой кнопки (`App.tsx` `caps.*` → какой permission в `deriveUiCaps`). Расхождение = баг.
- **Лечение:** гейтить UI-кнопку И серверный ledger-write на ОДНО право. Правка политики — `ledgerAuthz.ts` (+ `ledgerAuthz.test.ts`). Нужно новое право — добавить в `PermissionCode` + `PERMISSION_CATALOG` (`shared/permissions.ts`) и протянуть в `deriveUiCaps` (`canEditX = has(perms,'x')`). Раскат серверной части и клиента **координировать**: деплой сервера со строгим гейтом ДО клиента с новой кнопкой-гейтом = тот же рассинхрон наоборот; выдать новое право пользователям до/в момент деплоя. Инцидент 2026-06-23 (contract/customer: UI на `masterdata.edit`, сервер на `admin` → #557 хотфикс → #558 выделенное `contracts.edit`).

## M18 — `gh release download` молча недокачивает артефакт (.blockmap) на прод-деплое
- **Симптом:** команда из CLAUDE.md §Release шаг 7 `gh release download vX.Y.Z --pattern "*.exe" --pattern "latest.yml" --pattern "*.blockmap" -D /opt/matricarmz/updates --clobber` приехала **без `.blockmap`** (в каталоге только `.exe` + `latest.yml`), хотя в GitHub-релизе blockmap есть. Вывод команды пустой, ошибки нет. **Воспроизводится стабильно:** пропущен на v2026.624.49, v2026.624.1021 и v2026.624.1153 (сработал лишь на 623) — считать ожидаемым поведением multi-pattern, не «иногда».
- **Следствие:** без `<exe>.blockmap` на сервере роут `/updates/file/<exe>.blockmap` отдаёт 404 → клиентский blockmap-delta не включается → **все клиенты качают полный installer (~116 МБ) вместо дельты (~10 МБ)**. Тихая регрессия дельты на весь релиз.
- **Лечение:** **качать `.blockmap` отдельным `gh release download` вызовом** (CLAUDE.md §Release шаг 7 уже разнесён на два вызова) — multi-pattern его роняет. После download всегда сверять наличие всех 3 файлов (`ls /opt/matricarmz/updates/ | grep <version>` → ждём `.exe`, `.exe.blockmap`, `latest.yml`); докачивать ДО рестарта — сервер подхватывает blockmap при пересканировании каталога на рестарте (in-memory `updateTorrentService`). Проверка после рестарта: `curl -fsSkI .../updates/file/<exe>.blockmap` → `200` + `Accept-Ranges: bytes`. Инциденты 2026-06-24 (v2026.624.49/1021/1153). Общий принцип — brain pool #011 «верь содержимому ответа, не сигналу успеха» (exit 0 ≠ всё приехало; cross-link G88). Связано с дельта-засевом топлива (`PENDING_FOLLOWUPS` §хвосты релиза, M14).

## M19 — `git rm --cached` / `git pull` / `reset --hard` на проде грозит удалить ЖИВЫЕ данные (ledger внутри checkout'а)

- **Симптом:** при чистке репо (untrack/реклон/resync прод-checkout'а) `git status` показывает ledger-файлы (`backend-api/ledger/server-key.json`, `blocks/*.json`, `bootstrap.json`) как deleted; «безобидный» `git rm --cached` + последующий `git pull`/`reset --hard` на проде стирает их из рабочего дерева.
- **Корень:** прод-backend по умолчанию резолвит ledger в `cwd/ledger` (`DEFAULT_LEDGER_DIR = resolve(process.cwd(),'ledger')`, `ledgerService.ts`), а `cwd` = `WorkingDirectory` systemd-юнита = `…/MatricaRMZ/backend-api`. Если рантайм-каталог `backend-api/ledger/` оказался **закоммичен** (трекается), то это ОДНОВРЕМЕННО git-объект и живые данные. Любое удаление из git удаляет живой подписной ключ + ранние блоки → повреждение цепочки / потеря ключа.
- **Диагностика:** `systemctl cat <svc> | grep WorkingDirectory`; `git ls-files backend-api/ledger | wc -l` (>0 = трекается — опасно); сверь `sha256sum` живого `server-key.json` с `git show HEAD:…/server-key.json` (совпало = прод использует закоммиченный ключ).
- **Лечение:** до любых git-операций — **relocate live-ledger ВНЕ checkout'а** (`MATRICA_LEDGER_DIR=/home/valstan/matricarmz-ledger` в `/etc/matricarmz/matricarmz.env`, `mv` каталога при остановленных сервисах — rename атомарен в пределах ФС) + бэкап ключей. После relocate `backend-api/ledger` gitignored и пуст в checkout'е → `git reset --hard`/`pull` уже безопасны. Инцидент 2026-06-26 (H8): закоммиченный ledger в публичном репо (ключ + ПДн); см. `SECURITY.md` §инварианты, `PENDING_FOLLOWUPS` §Security.

## M20 — `/updates/status` показывает `stale_manifest`/старую версию после `ledger-publish` (до рестарта)
- **Симптом:** на прод-деплое после `corepack pnpm release:ledger-publish X.Y.Z` (шаг 8, ДО рестарта) `/updates/status` / `latest.json` отдают **предыдущую** версию, `lastError:"stale_manifest"`, `latestSource:"disk-fallback"`, `infoHash:null` или чужой; первый `ledger-publish` иногда пишет **частичный** `latest.torrent` (~2 КБ вместо ~18 КБ). Второй `ledger-publish` подряд однажды упал `ELIFECYCLE exit 1` (транзиент).
- **Корень:** работающий (ещё старый) backend держит состояние апдейтера **в памяти с момента старта** и периодически перегенерирует `latest.json`/`latest.torrent` из in-memory-состояния → затирает то, что записал `ledger-publish`, пока процесс не перезапущен. Первый publish мог записаться в момент этой перегенерации → частичный/устаревший манифест.
- **Диагностика:** после publish `cat /opt/matricarmz/updates/latest.json` — версия/`infoHash`/`torrentFile`; `ls -la latest.torrent` (размер ~18 КБ = полный). Расхождение с целевой версией → манифест затёрт живым процессом.
- **Лечение:** **порядок из CLAUDE.md держать** (download+publish ДО рестарта), но публиковать `ledger-publish` **дважды** и после — **обязательный рестарт**: новый backend читает финальные `latest.yml`/`latest.json` при старте и генерит корректный манифест. После рестарта сверять `/updates/status` (`lastError:null`, целевая версия, `infoHash` есть) + blockmap `200`. Не паниковать на 502 сразу после рестарта — backend поднимается ~13 с (health до этого пуст). Инциденты 2026-07-01 (релизы 843/941/1139/1325). Родственно M9 (dual-instance stale) / M18 (verify содержимого).

## M21 — фикс записи EAV (`setEntityAttribute`) не помог двигателям: у них свой write-путь `setEngineAttribute`
- **Симптом:** починил «список не обновляется после правки карточки» в `setEntityAttribute` (справочники/сотрудники) — а у **двигателей** баг остался.
- **Корень:** в клиенте (electron main) **несколько независимых write-путей атрибутов**. `admin:entities:setAttr`/`employees:setAttr` → `entityService.setEntityAttribute`, но `engine:setAttr` → **`engineService.setEngineAttribute`** (отдельная функция, свой дубль-баг: поиск строки по `(entity,attr)` без `deletedAt IS NULL`/сортировки, `limit(1)` → правит произвольную из дублей). Фикс одной функции не покрывает остальные.
- **Диагностика:** от IPC-канала (preload `window.matrica.<x>.setAttr` → `invoke('<chan>')`) дойти до фактического обработчика (`ipc/register/*`) и функции записи; свериться, что ВСЕ пути атрибутов имеют «свежайшая активная строка + гашение дублей». Грепнуть `.update(attributeValues).set({ valueJson` по `electron-app/src/main/services/*`.
- **Лечение:** во всех write-путях EAV — выбирать активную (`isNull(deletedAt)`) строку `orderBy desc(updatedAt)`, обновлять новейшую, soft-delete прочие активные; read-запросы списков сортировать `asc(updatedAt)` (свежайшее побеждает при остаточных дублях). Сервер держать чистым (`GROUP BY entity,def HAVING count>1` = 0). Исправлено #15 (`setEntityAttribute`, v1325) + #16 (`setEngineAttribute`, v1437). Родственно M8 (EAV-инкремент).

## M22 — после релиза изоляции у ВСЕХ операторов пустые списки нарядов (данные удалены purge с клиента)
- **Симптом:** после релиза «изоляции» списки нарядов/сущностей пустые у всех операторов (или остались только чужие/только свои); у одних работает, у других — нет, зависит от того, кто последним синхронизировался на машине.
- **Корень:** серверная изоляция чтения на sync-границе + клиентский **purge** (`db.delete(operations)` — жёсткое удаление) удаляли строки из локального SQLite по роли синкающегося. При переходе на модель «полная база на клиенте + фильтр на отображении» удалённые данные **не возвращаются инкрементом** (only-forward), а фильтр прячет остаток → пустой список. Локальная база оказалась привязана к последнему синкавшемуся, а не к авторизованному.
- **Диагностика:** сервер держит все строки (`SELECT count(*)` по таблице)? Да → потеря локальная. `client_settings.last_version` — на какой версии клиент. Проверить, был ли purge-эндпойнт/клиентский delete в раскатанных версиях.
- **Лечение:** **никогда не удалять синканные строки из локального кэша ради разграничения** — разграничение делать фильтром отображения (shared-политика, по авторизованному пользователю), держа полную базу. Восстановление уже пострадавших клиентов — бродкаст `force_full_pull_v2` всем: `UPDATE client_settings SET sync_request_id=gen_random_uuid()::text, sync_request_type='force_full_pull_v2', sync_request_at=(extract(epoch from now())*1000)::bigint` (клиент при опросе делает полный pull; `if(fullPull)` → `clearLocalSyncTablesForFullPull` чистит локалку и перезаливает с сервера). Инцидент 2026-07-01 (изоляция нарядов Рамзии, релизы 941/1024→1139). Урок переносим — письмо в brain (разворот #063).

## M23 — значение застряло в списке, хотя карточка правится и `setAttr` корректен (dual-source read)
- **Симптом:** в СПИСКЕ поле показывает старое значение, в КАРТОЧКЕ то же поле правится и сохраняется; ресинк и фикс дублей (M20/M21) не помогают; на сервере у сущности — одна строка атрибута, дублей нет. Затрагивает часть записей, а не все (у «свежих» сущностей работает).
- **Корень:** список и карточка читают/пишут **РАЗНЫЕ атрибуты** для одного логического поля. Пример: «Дата отгрузки» — карточка правит статус-дату `status_customer_sent_date`, а список/отчёт читали прямой EAV-атрибут `shipping_date`, **предпочитая его** (`explicit ?? status ?? …`). Прямой атрибут — замороженный импорт (пишется только миграцией, карточкой не трогается) → у импортированных записей он не пуст и навсегда перекрывает свежую правку карточки. Родня — `is_scrap` (OR с живым `status_rejected`).
- **Диагностика:** (1) найти, что реально пишет карточка (`saveAllAndClose`/`setAttr` — какой code) vs что читает список-сервис (`list*`/`report*`). Если коды разные — dual-source. (2) Замороженность подтвердить на проде: `SELECT max(updated_at) ... GROUP BY attribute_def` — legacy-атрибут имеет старый `max(updated_at)` (импорт-окно) и много строк. (3) Explore-свип остальных модулей на тот же паттерн (обычно локализован в кастомных сервисах вроде `engineService`, generic-EAV не страдает).
- **Лечение:** развернуть приоритет чтения — **основным сделать атрибут, который правит карточка**, legacy-атрибут оставить историч. фолбэком (`status ?? … ?? legacy`), **без мутации данных** (обратимо). Legacy-значения остаются для записей без свежей правки и «оживают» при первом же редактировании карточки. Инцидент 2026-07-01 (`2Ж03АТ0479`, #18/#19, v2026.701.1708). Централизуй резолвер, если таких read-путей несколько (у двигателей их два: `listEngines` + `resolveEngineShippingState`).

## M24 — `db:migrate` на проде падает `must be owner of table X` (ownership drift)
- **Симптом:** релизный `corepack pnpm -F @matricarmz/backend-api db:migrate` падает `error: must be owner of table <X>` (code 42501), хотя миграция локально проходила. Drizzle-мигратор атомарен — **вся пачка pending-миграций откатывается** (включая невиновные), состояние БД чистое.
- **Корень:** таблица `<X>` когда-то создавалась на проде **вручную под `postgres`** (psql-сессией суперпользователя), а не приложенческим юзером (`valstan`) через мигратор → `ALTER TABLE`/`DROP` на неё требуют ownership, которого у приложенческого юзера нет. Локально не воспроизводится (dev-БД целиком создана одним юзером).
- **Диагностика:** `SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public' AND tableowner <> current_user;` — все таблицы должны принадлежать приложенческому юзеру.
- **Лечение:** `sudo -u postgres psql -d "$PGDATABASE" -c 'ALTER TABLE <X> OWNER TO valstan;'` (metadata-only, безопасно) → повторить `db:migrate`. Постоянный фикс. Инцидент 2026-07-02 (`ai_chat_history`, релиз v2026.702.1024, миграция 0072).

## M25 — upsert BOM падает «в варианте __kit_* отсутствуют обязательные типы», хотя правишь только base-строки
- **Симптом:** сохранение/скриптовый merge BOM падает `BOM не сохранен: в варианте «__kit_…» отсутствуют обязательные типы из глобальной схемы: ring`, хотя kit-варианты не трогались — добавлялись только строки base.
- **Корень:** `upsertWarehouseAssemblyBom` — **full-replace**: пересохраняет ВСЕ строки BOM и заново валидирует каждый `__kit_*`-вариант на полноту по глобальной схеме. Легаси-киты, сохранённые до ужесточения проверки (или до расширения required-набора схемы), сегодняшнюю валидацию не проходят → любое добавление строк через upsert блокируется чужим легаси-состоянием.
- **Диагностика:** `select variant_group, component_type, count(*) ... group by 1,2` по строкам BOM — видно, каких required-типов нет в конкретном ките.
- **Лечение:** для аддитивных импортов НЕ пересохранять весь BOM: точечные insert/update строк + явная ledger-подпись (payload как в сервисе) + `ensureNomenclatureBrandPart` per новая строка — киты не трогаются. Образец: `backend-api/src/scripts/importZamenaKrBomNorms.ts` (инцидент 2026-07-02, импорт «Замена при КР»). Чинить сами киты — отдельное осознанное действие владельца в UI.

# Ledger без блокчейна: журнал изменений в PostgreSQL

**Статус:** ACTIVE (2026-09-05). Решение владельца 05.09 (вечер): убрать цепочку блоков из пути записи. Истина — PostgreSQL (вариант А от 05.09 утра), история — журнал в PG (`ledger_tx_index`, он уже есть и уже полный), нумерация seq — последовательность PG. Подписи, шифрование строк на диске сервера, проекция `state.json`, чекпоинты и блоки — уходят. «Нормальный обмен через реестр» если понадобится — в Матрице 4 с чистого листа.

## Context — почему

Замер 05.09: полезных данных в PG < 300 МБ (база 872 МБ, из них 572 МБ — сам журнал `ledger_tx_index`), а цепочка — 397 244 файла на 4,4 ГБ + проекция 275 МБ. Клиенты цепочку **не читают**: `/state/snapshot` и `/state/changes` идут из PG по `last_server_seq`. Цепочка участвует только в записи: каждый push → подпись → блок на диск → `loadState/applyTxs/saveState` **всей** проекции (218–287 МБ). Отсюда «одна сущность в минуту» (M79), `bad_alloc` на пределе строки V8 (M105), гонки писателей и блоки-призраки (M104), три дня ремонта на этой неделе. Защиты от взлома цепочка не даёт (подписывает сам сервер), от потери данных защищает бэкап PG.

## Целевая конструкция

- **Журнал = `ledger_tx_index`** (имя таблицы не меняем — 572 МБ, индексы, читатели в отчётах и pull). Добавляются `actor_user_id`, `actor_username` (были в блоке, в индексе — нет). `payload_json` — открытый текст строки **со штампом** `last_server_seq` (в цепочке штампа не было, отсюда вечное «разных=N» в сверках).
- **seq = `SEQUENCE ledger_seq`**, стартует с `max(server_seq)` журнала (и не ниже `lastSeq` из `index.json` цепочки — проверить руками при выкате). Выдача seq и запись в журнал — одна транзакция под `pg_advisory_xact_lock` (одна константа на оба инстанса): порядок seq = порядок записи, как давал файловый замок.
- **`ledgerService` остаётся фасадом** с прежними именами (`signAndAppendDetailed`, `signAndAppend`, `getLedgerLastSeq`, `queryState`), но все — `async` и поверх PG. Вызовов `signAndAppendDetailed` ~30 (сервисы склада, BOM, дедуп деталей, скрипты) — правка механическая: `await`. `LedgerTxPayload`/`LedgerTableName` живут в пакете `ledger` как прежде (типы контракта); `LedgerStore`, `applyTx`, ключи, keyring — удаляются.
- **`queryState`** — над PG: sync-таблицы через `PG_SYNC_TABLES` (та же DTO-форма), `release_registry` — новая таблица PG (бэкфилл из журнала миграцией), прочие — пусто. Семантика фильтров/сортировки/курсора сохраняется (читатели: `/state/query` web-admin, fallback `/state/snapshot`, диагностика).
- **Уходят:** `/ledger/blocks`, `/ledger/checkpoint/*`, `/diagnostics/ledger/replay` → 410; `ensureLedgerBootstrap`; догон индекса из цепочки (`ledgerTxIndexService`); `ledgerReplayService`; инструменты цепочки (`rebuild-state`, `resnapshot-state`, `rebuildLedgerTxIndex`, `rotate-data-key`, `ledger:import`) вместе с тестами; `dataKeyring`; `MATRICA_LEDGER_DIR`/`MATRICA_LEDGER_DATA_KEY` из окружения backend.
- **Клиентский контракт не меняется:** `/ledger/tx/submit` (ответ той же формы, `block_height` = 0), `/state/*`, `/schema/snapshot`. Клиент ничего не знал о блоках.
- **Бэкап:** `backup-encrypted.sh` архивирует только PG, ledger-дерево — опционально (если каталог есть). Цепочка архивируется один раз и уезжает на Я.Диск.

## Этапы

### J1 — код (один PR)

1. Пакет `ledger`: оставить `types.ts` (+ `hashTxPayload` из `crypto.ts`), удалить `store.ts`, `state.ts`, подпись/ключи.
2. Миграция `0091_ledger_journal.sql`: `ledger_seq`, колонки актора, `release_registry` + бэкфилл из журнала.
3. `ledgerService.ts` заново (журнал в PG, ~150 строк вместо 600). `writeSyncChanges`: `await`, шаг 3 (вставка в индекс) убирается — журнал пишет сам фасад. `pullChangesSince`: без догона, `await getLedgerLastSeq()`.
4. `routes/ledger.ts`: 410 на блоки/чекпоинты, релизы на PG, без bootstrap. `routes/diagnostics.ts`: replay → 410. Диагностика (`diagnosticsConsistencyService`, `diagnosticsSyncPipelineService`, супервизор): `queryState` async, `ledgerToIndexLag` = 0 и уходит из текста.
5. `await` у прямых писателей (склад ×6, BOM ×8, дедуп ×1, `appendLedgerChanges`, скрипты ×12). Удаление инструментов цепочки и их тестов. Тесты с моками `ledgerService` — на `mockResolvedValue`.
6. `backup-encrypted.sh` + смоук: ledger-дерево опционально. `.env.example`, `docs/*`, `AGENTS.md` §Project overview («не обходить ledger» → «все записи через `writeSyncChanges`»).
7. Гейты, PR.

### J2 — прод (по OK владельца)

**Переписан 06.09 по итогам состязательной ревизии** (workflow `ledger-journal-preflight`, 9 линз): прежний порядок «мигрируем на живой системе, потом рестартуем» был блокером. Пока работает старая сборка, номера раздаёт её файловый счётчик цепочки, и он пишет в тот же `ledger_tx_index`. Два счётчика против первичного ключа дают либо занятый номер (отказ записи у половины парка — nginx балансирует между старым и новым инстансом), либо строку с номером ниже курсора клиента, которую клиент не увидит уже никогда.

**Писатели останавливаются на время миграции. Это не перестраховка, а единственное, что закрывает второй случай.** Окно простоя — минуты; парк офлайн-устойчив (клиенты копят пуш локально).

1. **Предпроверки (read-only).**
   ```
   grep -E "lastSeq" ~/matricarmz-ledger/index.json          # счётчик цепочки
   psql -c "SELECT max(server_seq) FROM ledger_tx_index"      # должен совпасть с ним
   psql -c "SELECT count(*) FROM ledger_tx_index WHERE table_name='release_registry'"   # ожидание 112
   ```
   В проекции цепочки выпусков **412**, в журнале — **112**: догон из цепочки для этой таблицы остановился на seq 503 657. Разницу закрывает шаг 5, и до него каталог цепочки не трогаем.
2. **Останов, миграция, старт.** Именно в этом порядке:
   ```
   git pull --ff-only && corepack pnpm -F @matricarmz/shared -F @matricarmz/ledger -F @matricarmz/backend-api -F @matricarmz/web-admin build
   sudo systemctl stop matricarmz-backend-primary matricarmz-backend-secondary
   corepack pnpm -F @matricarmz/backend-api db:migrate
   psql -c "SELECT last_value FROM ledger_seq"                # обязан быть = max(server_seq)
   sudo systemctl start matricarmz-backend-primary matricarmz-backend-secondary
   ```
   Сборка идёт ДО останова, чтобы простой был только на миграции. Ручной `setval` больше не нужен: миграция ставит старт последним шагом, при остановленных писателях максимум журнала не двигается, а если счётчик всё же отстанет — `ledgerService.ensureSequenceAheadOfJournal` поднимет его сам и повторит запись.
3. **Приёмка.** `/health` по каждому порту отдельно (3001 биндится ~50 с, M100), затем пуш с любого клиента и:
   ```
   psql -c "SELECT server_seq, table_name, actor_username FROM ledger_tx_index ORDER BY server_seq DESC LIMIT 3"
   ```
   Новые строки обязаны нести актора — до 0091 колонки не было, значит запись идёт новым путём.
4. **Скрипт бэкапа переустановить СЕЙЧАС, до любых действий с каталогом цепочки.** `/usr/local/sbin/matricarmz-backup-encrypted` — это КОПИЯ, положенная `install`-ом, а не ссылка на клон: пока её не обновить, она несёт прежний жёсткий отказ «ledger dir has no blocks/» и после удаления каталога будет валить ночной бэкап каждую ночь, отправляя ❌ в Telegram ещё до `pg_dump`.
   ```
   bash scripts/prod-ops/install-prod-ops.sh          # идемпотентно, парольную фразу сохраняет
   sudo -Hu <сервисный пользователь> /usr/local/sbin/matricarmz-backup-encrypted --no-upload
   ```
   Ждём в логе строку `verified: db.dump only listed` (при ещё живом каталоге цепочки — обычную строку с блоками; тогда повторить приёмку после шага 6).
5. **Реестр выпусков — из проекции в таблицу.** Миграция подняла только 112 старых записей; без этого шага web-admin показывает администратору выпуск годичной давности.
   ```
   corepack pnpm -F @matricarmz/backend-api ledger:import-release-registry -- --from ~/matricarmz-ledger/state.json
   corepack pnpm -F @matricarmz/backend-api ledger:import-release-registry -- --from ~/matricarmz-ledger/state.json --apply
   curl -fsk https://127.0.0.1/ledger/releases/latest
   ```
   Приёмка: `count(*) FROM release_registry` ≈ 412 и последний выпуск = **v3.19.0**.
6. **Бэкфилл строк списка деталей заново** (`engine-inventory:backfill-lines` dry-run → `--apply`): теперь запись — вставка в журнал и в таблицу, без переписывания проекции, ожидание минуты вместо часов. Контроль живости по pid-файлу и счётчику строк, не по `pgrep -f` (M106).
7. **Каталог цепочки — отдельным днём, отдельным OK.** Не раньше, чем новый путь отработает полный рабочий день. Архив `tar -I zstd` на Я.Диск, сверка размера и хэша, и только потом удаление. `MATRICA_LEDGER_DIR` из `/etc/matricarmz/matricarmz.env` снимать **последним**, вместе с удалением.

**Откат.** Пока каталог цепочки и `MATRICA_LEDGER_DIR` на месте (шаг 7 не сделан), откат = `git checkout <прежний коммит> && build && restart`. Старая сборка читает свой `index.json` и продолжает с прежнего номера; новые строки, записанные новым путём, она увидит как обычные строки журнала.

⚠️ **После шага 7 отката нет, и попытка отката ломает данные.** Старая сборка без `MATRICA_LEDGER_DIR` берёт `<cwd>/ledger`, создаёт там пустую цепочку с новыми ключами, получает `lastSeq = 0` и начинает штамповать строки номерами 1, 2, 3 — при курсорах клиентов около 1 557 929. Это ровно инцидент **M30**. Поэтому: если после шага 7 всё же нужен откат, перед стартом старой сборки обязательно вернуть каталог из архива и выставить в `index.json` `lastSeq = max(server_seq)` из `ledger_tx_index`.

### J3 — хвосты

- `ledger_tx_index` 572 МБ раздут теми же `meta_json`; после E3 плана `engine-inventory-lines` записи станут строчными. Ретенция журнала — отдельное решение.
- Гонка «номер выдан, строка таблицы ещё не закоммичена, клиент уже забрал курсор» существовала и с цепочкой. Журнальные строки теперь коммитятся строго в порядке номеров (advisory-lock), но строки sync-таблиц пишутся отдельной транзакцией после — там порядок не гарантирован. Правильное лечение — запись журнала и таблиц в одной транзакции; вместе с узлом офлайн-записи (план v4, трек B).
- Письмо brain'у: класс «журнал с проекцией и подписью на одном сервере — цена без пользы» и класс «два счётчика против одного первичного ключа во время выката».

## Что сознательно не делаем

- Не переименовываем `ledger_tx_index`, пакет `ledger`, маршруты `/ledger/*` — контракт клиентов и парк 3.19.
- Не переносим шифрование строк в PG: диск сервера и бэкап уже шифрованы целиком.
- Не чистим журнал от старых записей в этом заходе.

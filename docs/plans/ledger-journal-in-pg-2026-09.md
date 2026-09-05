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

### J2 — прод (по OK владельца, вне окна бэкапа)

1. Перед выкатом: `lastSeq` из `~/matricarmz-ledger/index.json` vs `max(server_seq)` журнала; число `release_registry` в журнале (ожидание 39).
2. `git pull` → build → `db:migrate` (0091) → при нужде `setval('ledger_seq', <lastSeq цепочки>)` → рестарт обоих инстансов → push с клиента и `/state/changes` работают (проверить по `ledger_tx_index`: новые строки с актором).
3. Архив цепочки: `tar -I zstd -cf ~/ledger-archive-20260905.tar.zst -C ~ matricarmz-ledger` (4,4 ГБ JSON → ожидание ~0,6 ГБ) → на Я.Диск → проверить размер/хэш → **удалить каталог** (деструктив, отдельный OK). Снять `MATRICA_LEDGER_DIR` из `/etc/matricarmz/matricarmz.env`.
4. Бэкфилл строк списка деталей заново (`engine-inventory:backfill-lines --apply`): теперь блок = вставка в журнал + PG, без проекции; ожидание — минуты. Честный контроль живости (pid-файл + счётчик).
5. Ночной бэкап проходит без ledger-дерева (лог `backup-encrypted`).

### J3 — хвосты

- `ledger_tx_index` 572 МБ раздут теми же `meta_json`; после E3 плана `engine-inventory-lines` записи станут строчными. Ретенция журнала — отдельное решение.
- Гонка «seq выдан, PG ещё не закоммичен, клиент уже забрал курсор» существовала и с цепочкой (`computeSafeLimit` в pull смягчает). Правильное лечение — выдача seq и запись PG в одной транзакции; вместе с узлом офлайн-записи (план v4, трек B).
- Письмо brain'у: класс «журнал с проекцией и подписью на одном сервере — цена без пользы».

## Что сознательно не делаем

- Не переименовываем `ledger_tx_index`, пакет `ledger`, маршруты `/ledger/*` — контракт клиентов и парк 3.19.
- Не переносим шифрование строк в PG: диск сервера и бэкап уже шифрованы целиком.
- Не чистим журнал от старых записей в этом заходе.

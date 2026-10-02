# Зеркала справочников в синк — pull-only реплики (2026-10)

**Статус:** IN-REVIEW, код готов 2026-10-02 (S1–S5), ветка `feat/sync-mirror-dictionaries`
**Основание:** `docs/PENDING_FOLLOWUPS.md` §«Связи… осталась одна из трёх» + `CODEBASE_MAP.md` §«Складские справочники»:
контрагенты, договоры и марки читаются клиентом из EAV-реплики (`customer`/`contract`/`engine_brand`),
а строгие `erp_counterparties` / `erp_contracts` / `directory_engine_brands` в sync-контракт не входят.
**Образец:** реплика `warehouse_locations` (R3, миграция `0093`, релиз v3.41.0).

Вне скоупа: сотрудники (территория R4b), `directory_services` (нет триггерного зеркала —
отдельная работа), cutover записи (EAV остаётся источником правды), B6.

## Почему pull-only, а не cutover

Писатели доменов — офлайн-клиенты через EAV-синк. Флип записи — это узел офлайн-записи
(план v4, сверка 2026-08-27), которого нет. Реплика строгих таблиц клиентам даёт:
честные подписи/фильтры без сети + фундамент под будущий cutover. Запись не трогаем.

## Состав работ

### S1. Сервер: sync-колонки + pending-только-на-реальном-изменении (миграция 0102) ✅

- `sync_status text NOT NULL DEFAULT 'synced'`, `last_server_seq bigint` + индекс — на все три таблицы.
  Существующие строки — `pending` (иначе `NULL > since` не TRUE и они не доедут никогда, 0093:10-14).
- `rebuild_erp_counterparty` / `rebuild_erp_contract` / `mirror_engine_brand_*`:
  ставить `pending` **только на реальном изменении зеркалируемых колонок**
  (`WHERE ... IS DISTINCT FROM ...`, приём users R3). Иначе правка телефона контрагента
  рассылала бы строку всему парку — самая дешёвая таблица станет самой болтливой.
- Drizzle `schema.ts`: колонки в три таблицы.

### S2. Сервер: контракт и журнал

- `shared/src/sync/tables.ts`: `ErpCounterparties`, `ErpContracts`, `DirectoryEngineBrands`.
- `shared/src/sync/dto.ts`: row-схемы (полная строка: лукапам нужны подпись+код,
  остальное — задел; платежи едут внутри `payments_json` как есть, read-only).
- `shared/src/sync/registry.ts`: записи (`conflictTarget: ['id']`,
  `dependsOn`: контракты после контрагентов — FK `customer_id`, как доступы после аккаунтов).
- `ledger/src/types.ts`: три имени. `shared/src/domain/ledgerAuthz.ts`:
  владение `server` + построчные требования; сторож `syncTableOwnership` сам потребует записи
  (typecheck не пройдёт без неё). `docs/WRITE_DOORS.md`: три строки.
- `SYNC_COLUMNS_PENDING_CONTRACT`-сторож: таблицы входят в контракт тем же релизом (прецедент #720/#721).

### S3. Сервер: публикатор

- Один `dictionarySyncPublisherService` на три таблицы (паттерн
  `warehouseLocationsSyncPublisherService`): тик 60 с, только primary,
  `pending` → `writeSyncChanges` → seq. Старт в `index.ts`, тест как `warehouseLocationsPublisher.test.ts`.
- Backstop клиентской записи — в `SERVER_MANAGED_SYNC_TABLES` (как склады).

### S4. Клиент: реплики

- `electron-app/drizzle/0027+0028+0029` (`IF NOT EXISTS`, реплика-не-строже как 0024:
  без CHECK/unique кроме PK) + паритет в `migrate.ts` (**все три цепочки**:
  drizzle-журнал, `clientSchemaMigrations`, `android-app/src/db/migrate.ts` — урок R3).
- Приём строк — проверить, что путь дженерик по реестру (`upsertPulledRowsInChunks`);
  если для `warehouse_locations` есть ручная ветка — продублировать на три таблицы.

### S5. Клиент+сервер: читатели на строгие таблицы

- `localWarehouseLookups` (`erpService.ts:675`): контрагенты/договоры/марки —
  из строгих реплик; правила подписей те же (`warehouseLookupsReplica.ts`),
  сверка с сервером 1-в-1 (прецедент: расхождение порядка складов поймал стенд).
- Серверный `listWarehouseLookups`: те же три списка — со строгих таблиц
  (внимание: сейчас часть списков строится из EAV — флип парой с клиентом,
  иначе один список станет двумя разными).
- Fallback «пустая реплика → сеть» (`warehouseLookupsGet:730`) оставить как есть.

### S6. Совместимость парка и выкат

- Смена состава таблиц меняет hash схемы → обработка старых сборок как в #737
  (замороженный состав; аддитивность: незнакомая таблица игнорируется, 426 не трогать — урок R3).
- **Выкат отдельным релизом** (правка контракта синка — класс, ронявший pull всему парку):
  `db:migrate` → рестарт → `dictionary sync publisher started` + `published` с числом строк →
  `... where last_server_seq is null` → 0 → новый клиент (реплики налиты, лукапы без сети) →
  старый клиент (незнакомые таблицы не мешают).
- Попутно вычистить из PENDING протухший подпункт «реплика складов ждёт релиза»
  (выпущена в v3.41.0, COMPLETED 2026-09-18).

## Приёмка

- [x] Паритет подписей сервер/клиент по трём спискам — код 1-в-1 с серверными
  `listCounterpartyLookup` / `listContractLookup` / `listEngineBrandLookup`
  (те же фильтры живых/активных, те же правила подписей; тесты `warehouseLookupsReplica` зелёные).
- [x] Живой прогон на пустой PG (02.10): цепочка 0000→0102 накатывается; EAV-правка →
  триггер → `pending`; холостой rebuild — тишина (`synced`, `updated_at` не тронут);
  изменение → `pending`; soft-delete → тумбстоун `pending` (проба S1, 6/6).
- [x] Живой прогон публикатора (02.10): 3 `pending`-строки → `writeSyncChanges` →
  seq в журнале → `pullChangesSince` отдаёт все 3 с `last_server_seq`; строк без seq — 0.
- [x] S6 ВЫПОЛНЕНА на проде 02.10 (релиз v3.57.0): артефакты положены до рестарта
  (`.exe` 136959786 Б, `.blockmap`, `latest.yml`, APK `MatricaRMZ-3.57.0.apk`);
  M40 — файл=манифест с первой пробы; `db:migrate` (0102, аддитивная);
  по пути поймана и снята procedural-ошибка (миграция до `git pull` ушла не в ту
  ревизию — лечится порядком pull→migrate, см. урок ниже);
  `release:ledger-publish 3.57.0`; `deploy-backend.sh` с явным run-id
  (совпал с HEAD, deps на месте, backup-снимок, primary+secondary за 6с+6с, health 3.57.0).
  Приёмка: `:3001`/`:3002`/nginx — все 3.57.0; `/updates/status` latest 3.57.0,
  `lastError: null`, size совпал; blockmap 200; паблишер за тик разобрал всё —
  `pending=0, nullseq=0` (контрагентов 97, договоров 110, марок 93);
  android `update-plan` 3.56.0→3.57.0 с sha256; прод-репозиторий чист.
- Урок выката (в процедуру, не в код): строки `publisher started/published` в прод-журнале
  искать бесполезно — prod-логгер роняет INFO без `critical:true` (см. PENDING §аудит
  Telegram, п.1: счётчик молчащих отказов). Живой сигнал публикатора — не лог, а
  `pending/nullseq`-счётчики по таблицам. Чек-лист «в логе primary … started» из R3-поры
  этому противоречит — проверять счетами, не логами.
- Попутно вычищен протухший подпункт PENDING «реплика складов ждёт релиза» (выпущена в v3.41.0).

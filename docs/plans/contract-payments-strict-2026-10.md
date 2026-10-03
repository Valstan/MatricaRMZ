# Платежи контрактов: EAV → строгие таблицы (B2-хвост трека B)

**Статус:** IN REVIEW (2026-10-03, ветка `feat/contract-payments-strict`)
**Контекст:** план [matrica-v4-kickoff-2026-08.md](matrica-v4-kickoff-2026-08.md), этап B2. Решение владельца 03.10: платежи → полная нормализация (не JSON-в-erp_contracts); запись — push через синк (офлайн как у EAV).

## Цель

`contract_payments` (EAV JSON на контракте) перестаёт быть источником правды. Платежи живут в двух строгих таблицах:

- `erp_contract_payment_slots` — слот (uuid): `contract_id`, `section_key` ('primary' | 'ДС {seq}'), `engine_brand_id` (nullable), `engine_id` (nullable), `contract_price_kop` (nullable), `deleted_at`, sync-колонки.
- `erp_contract_payments` — строка платежа (uuid): `slot_id` FK→slots, `date`, `amount_kop`, `kind` (contract_price/advance/extra_advance/final), `note`, `countdown_start` (bool), `deleted_at`, sync-колонки.

Идентичность строк — uuid из текущего JSON (`slot.id`, `payment.id`): backfill 1:1 без remap, ссылки в JSON-атрибутах/операциях не рвём.

## Дизайн

- **Запись — push через синк** (решение владельца 03.10; платежи правят бухгалтера и с планшета в цеху — офлайн работает как сегодня для EAV). Клиент пишет id-uuid строки в локальную SQLite → автоpush → `applyPushBatch` (handler по образцу `erp_contracts` в `applyPushBatch.ts:2303`) валидирует zod-схемой и пишет PG → `updateSeqAndCollect` штампует seq → pull развозит всем.
- **Публикатор** для outbox-пути (как `dictionarySyncPublisherService`): строки, записанные сервером (backfill, скрипты), идут через `writeSyncChanges`.
- `erp_contracts.payments_json` остаётся **зеркалом, собранным из строгих таблиц** (или вырождается в null) — решение на момент cutover: триггер 0084/0102 `rebuild_contract` перестаёт брать payments из EAV (payments_json из EAV замораживается); источник payments_json переносится на пересборку из новых таблиц — для AI `llmTools` (читает sections_json/payments_json) и отладки.
- Читатели переключаются с EAV-атрибута на реплику строгих таблиц: `contractPaymentsStore` (read: join slots+payments → ContractPayments), `reports/presets/payments.ts`, удалительный гейт (`entityService`/`adminMasterdataService` — ссылки engineId слотов).
- EAV `contract_payments`: запись закрывается гейтом (write-side freeze), значение остаётся для history до B6.

## Шаги

1. ✅ **PG-миграция `0104`** — две таблицы + sync-колонки + индексы + `sync_contract_payments()` (бэкфилл + живое зеркало EAV→strict на переходный период) + триггер `trg_mirror_contract_payments_attr`. Проверена на чистой БД (вся цепочка) и на фикстуре с мусором (канонизация секций, pending только на реальном изменении, soft-delete исчезнувших).
2. ✅ **Контракт синка** (28 → 30 таблиц): `SyncTableName` + `LedgerTableName`, zod-схемы, реестр (dependsOn: контракты → слоты → платежи), `pgSyncTables`, `pullChangesSince`, handler'ы `applyPushBatch` с FK-проверками, `SYNC_TABLE_OWNERSHIP`/`TABLE_REQUIREMENT` (`contracts.edit`), label в `changes.ts`, публикатор словарей расширен (порядок: договоры → слоты → платежи).
3. ✅ **Клиентские реплики**: drizzle `0030/0031` + parity-блоки в обоих `migrate.ts` + `schema.ts`; `syncService` — pull-группировка/применение, push-сбор pending, ack, recovery; `errorRecovery`, `dependencyRequeue` (`slot` — в очередь, `contract` — в error: сервер пишет договоры сам).
4. ✅ **Читатели**: `contractPaymentsReplica` (read из strict + EAV-фолбэк по свежести, write диффом в pending) + IPC `contractPayments:*` (гейт секции «Договоры», запись — editor) + preload + `MatricaApi` + переписанный `contractPaymentsStore` (API сохранён); отчёты `payments.ts` — из strict; гейты удаления — strict (клиент + EAV-фолбэк при пустом strict, сервер — strict: триггер синхронен).
5. ⬜ **Freeze** (следующий шаг, НЕ в этом PR): после обновления парка — гейт записи EAV-`contract_payments`, снос триггера зеркала, перепись `resyncContractSlots` на strict. Предусловия как у R4b: parity зелёный + парк на новой сборке.
6. ✅ **Приёмка**: `payments:parity` (EAV↔strict, обе стороны проверены вживую); тесты: публикатор (16), реплика (5), incomingReferences (+strict-кейс), humanLabels (68). CDP-смоук правки платежа — отдельно перед релизом.

## Хвосты (другие EAV-атрибуты контракта)

`contract_sections` остаётся JSON в EAV — это отдельное переосмысление (JSON-в-строгом-мире решён как «строгие таблицы» только для платежей пока не расширяем). AI-зеркало `sections_json/payments_json` поддерживается пересборкой.

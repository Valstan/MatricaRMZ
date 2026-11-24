-- Цех производственной программы — из справочника `directory_workshops`
-- (миграция сервера 0140, владелец 24.11.2026: «выбор цеха происходит не из базы,
-- а это неправильно, надо чтобы цех выбирался из базы»).
--
-- Nullable — ровно как на сервере, иначе checkReplicaStrictness уронит pull.
--
-- Тот же DDL продублирован в `ensureClientSchemaParity`
-- (electron-app/src/main/database/migrate.ts) и в android-миграторе
-- (android-app/src/db/migrate.ts); журнал клиентской drizzle-цепочки не бампаем —
-- прецедент 0033–0041.

ALTER TABLE `erp_production_programs` ADD COLUMN `workshop_id` text;

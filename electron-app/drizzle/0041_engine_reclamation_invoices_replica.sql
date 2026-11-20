-- Накладные по заезду по рекламации (миграция сервера 0137, владелец 20.11.2026).
--
-- Номер накладной прихода и отгрузки — по заезду: у основного цикла накладные в
-- карточке двигателя, у заезда по рекламации — свои.
--
-- Nullable — ровно как на сервере, иначе checkReplicaStrictness уронит pull.
--
-- Тот же DDL продублирован в `ensureClientSchemaParity` (electron-app/src/main/database/migrate.ts)
-- и в android-миграторе (android-app/src/db/migrate.ts); журнал клиентской drizzle-цепочки
-- не бампаем — прецедент 0033–0040.

ALTER TABLE `erp_engine_reclamations` ADD COLUMN `arrival_invoice` text;
--> statement-breakpoint
ALTER TABLE `erp_engine_reclamations` ADD COLUMN `shipment_invoice` text;

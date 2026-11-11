-- Возврат СИЗ: «получил обратно» (миграция сервера 0126).
--
-- Три nullable-колонки в строке выдачи: дата возврата, кто принял, процент износа.
-- Тот же DDL продублирован в `ensureClientSchemaParity` (electron-app/src/main/database/migrate.ts)
-- и в android-миграторе (android-app/src/db/migrate.ts); журнал клиентской drizzle-цепочки
-- не бампаем — прецедент 0033–0037.
--
-- Nullable — ровно как на сервере, иначе checkReplicaStrictness уронит pull.

ALTER TABLE `ppe_issue_entries` ADD COLUMN `returned_at` integer;
--> statement-breakpoint
ALTER TABLE `ppe_issue_entries` ADD COLUMN `returned_by` text;
--> statement-breakpoint
ALTER TABLE `ppe_issue_entries` ADD COLUMN `wear_percent` integer;

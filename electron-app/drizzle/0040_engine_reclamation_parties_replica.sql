-- Свой договор и контрагент у каждого заезда по рекламации (миграция сервера 0136,
-- промты КАРМАНА #42/#43, владелец 19.11.2026).
--
-- `contract_id` — договор ЗАЕЗДА (не карточки): движок мог вернуться по рекламации
-- уже по другому договору. `customer_id` — контрагент заезда (заказчик/поставщик),
-- запасной путь: если договора нет, заказчик берётся отсюда.
--
-- Nullable — ровно как на сервере, иначе checkReplicaStrictness уронит pull.
--
-- Тот же DDL продублирован в `ensureClientSchemaParity` (electron-app/src/main/database/migrate.ts)
-- и в android-миграторе (android-app/src/db/migrate.ts); журнал клиентской drizzle-цепочки
-- не бампаем — прецедент 0033–0039.

ALTER TABLE `erp_engine_reclamations` ADD COLUMN `contract_id` text;
--> statement-breakpoint
ALTER TABLE `erp_engine_reclamations` ADD COLUMN `customer_id` text;

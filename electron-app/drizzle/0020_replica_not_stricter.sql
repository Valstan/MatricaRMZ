-- #086: клиентская реплика не имеет права быть строже сервера.
-- (1) user_presence.user_id: на сервере unique-гарантии нет (одна строка на юзера
--     держится конвенцией id === user_id) — клиентский unique снимаем до обычного индекса.
-- (2) BOM lines / engine instances: серверные unique частичные (deleted_at IS NULL),
--     клиентские были полными — soft-deleted дубль с сервера ронял бы вставку.
-- Реальное имя в живых БД — user_presence_user_id_uq (0003/0005); schema.ts звал его
-- user_presence_user_uq и в цепочке такого никогда не было — дропаем оба на всякий случай.
DROP INDEX IF EXISTS `user_presence_user_id_uq`;--> statement-breakpoint
DROP INDEX IF EXISTS `user_presence_user_uq`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_presence_user_idx` ON `user_presence` (`user_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `erp_engine_assembly_bom_lines_variant_component_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `erp_engine_assembly_bom_lines_variant_component_uq` ON `erp_engine_assembly_bom_lines` (`bom_id`,`variant_group`,`component_nomenclature_id`,`component_type`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `erp_engine_instances_nomenclature_serial_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `erp_engine_instances_nomenclature_serial_uq` ON `erp_engine_instances` (`nomenclature_id`,`serial_number`) WHERE `deleted_at` IS NULL;

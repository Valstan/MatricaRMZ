CREATE INDEX IF NOT EXISTS `operations_type_deleted_updated_idx` ON `operations` (`operation_type`,`deleted_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operations_engine_type_idx` ON `operations` (`engine_entity_id`,`operation_type`);

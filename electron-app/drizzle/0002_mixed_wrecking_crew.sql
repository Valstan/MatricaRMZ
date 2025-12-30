CREATE INDEX `operations_sync_status_idx` ON `operations` (`sync_status`);--> statement-breakpoint
CREATE INDEX `attribute_defs_sync_status_idx` ON `attribute_defs` (`sync_status`);--> statement-breakpoint
CREATE INDEX `attribute_values_sync_status_idx` ON `attribute_values` (`sync_status`);--> statement-breakpoint
CREATE INDEX `audit_log_sync_status_idx` ON `audit_log` (`sync_status`);--> statement-breakpoint
CREATE INDEX `entities_sync_status_idx` ON `entities` (`sync_status`);--> statement-breakpoint
CREATE INDEX `entity_types_sync_status_idx` ON `entity_types` (`sync_status`);
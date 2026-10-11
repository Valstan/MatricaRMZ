-- Реплика таблиц модуля «Кладовщик» (учёт СИЗ), MVP.
-- Nullability — ровно как серверные ppe_* (миграция 0107), иначе
-- checkReplicaStrictness уронит pull. Даты — integer (Unix-ms).
-- Тот же DDL продублирован в `ensureClientSchemaParity` (migrate.ts) и в android-миграторе.

CREATE TABLE `ppe_norm_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`post_title` text,
	`department_id` text,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ppe_norm_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`norm_set_id` text NOT NULL,
	`nomenclature_id` text NOT NULL,
	`qty` integer NOT NULL,
	`wear_months` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ppe_issue_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ppe_card_norms` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`norm_set_id` text NOT NULL,
	`assigned_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ppe_issue_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`nomenclature_id` text NOT NULL,
	`qty` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`document_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_norm_sets_post_idx` ON `ppe_norm_sets` (`post_title`, `valid_from`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_norm_lines_set_idx` ON `ppe_norm_lines` (`norm_set_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_norm_lines_nomenclature_idx` ON `ppe_norm_lines` (`nomenclature_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ppe_norm_lines_set_nomenclature_uq` ON `ppe_norm_lines` (`norm_set_id`, `nomenclature_id`) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_issue_cards_employee_idx` ON `ppe_issue_cards` (`employee_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ppe_issue_cards_employee_open_uq` ON `ppe_issue_cards` (`employee_id`) WHERE `closed_at` IS NULL AND `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_card_norms_card_idx` ON `ppe_card_norms` (`card_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ppe_card_norms_card_set_uq` ON `ppe_card_norms` (`card_id`, `norm_set_id`) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_issue_entries_card_idx` ON `ppe_issue_entries` (`card_id`, `issued_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_issue_entries_nomenclature_idx` ON `ppe_issue_entries` (`nomenclature_id`, `issued_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_issue_entries_document_idx` ON `ppe_issue_entries` (`document_id`);

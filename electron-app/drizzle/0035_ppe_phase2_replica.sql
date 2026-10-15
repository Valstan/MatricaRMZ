-- Реплика фазы 2 модуля «Кладовщик» (условия норм, отпуска, группы, коллектив).
-- План: docs/plans/ppe-kladovshik-phase2.md (PR-0). Применяется поверх 0033.
-- Nullability — ровно как серверная 0110, иначе checkReplicaStrictness уронит pull.
-- Даты — integer (Unix-ms).
-- `ppe_issue_entries.document_id` здесь НЕ трогаем: SQLite не умеет снимать NOT NULL
-- через ALTER — долгоживущие БД пересобирает `ensureClientSchemaParity` (migrate.ts),
-- свежим таблица сразу создаётся nullable там же. Тот же DDL продублирован
-- в `ensureClientSchemaParity` (migrate.ts) и в android-миграторе.
ALTER TABLE `ppe_norm_sets` ADD COLUMN `gender` text;
--> statement-breakpoint
ALTER TABLE `ppe_norm_sets` ADD COLUMN `season` text;
--> statement-breakpoint
ALTER TABLE `ppe_norm_sets` ADD COLUMN `is_duty` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DROP INDEX IF EXISTS `ppe_norm_sets_post_idx`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_norm_sets_post_gender_season_idx` ON `ppe_norm_sets` (`post_title`, `gender`, `season`, `valid_from`);
--> statement-breakpoint
CREATE TABLE `ppe_absences` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`from_ms` integer NOT NULL,
	`to_ms` integer NOT NULL,
	`kind` text DEFAULT 'vacation' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_absences_employee_from_idx` ON `ppe_absences` (`employee_id`, `from_ms`);
--> statement-breakpoint
CREATE TABLE `ppe_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ppe_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ppe_group_members_group_employee_uq` ON `ppe_group_members` (`group_id`, `employee_id`) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_group_members_group_idx` ON `ppe_group_members` (`group_id`);
--> statement-breakpoint
CREATE TABLE `ppe_group_norms` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`norm_set_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ppe_group_norms_group_set_uq` ON `ppe_group_norms` (`group_id`, `norm_set_id`) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_group_norms_group_idx` ON `ppe_group_norms` (`group_id`);
--> statement-breakpoint
CREATE TABLE `ppe_collectives` (
	`id` text PRIMARY KEY NOT NULL,
	`department_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`document_id` text,
	`distributed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_collectives_department_idx` ON `ppe_collectives` (`department_id`);
--> statement-breakpoint
CREATE TABLE `ppe_collective_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`collective_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`nomenclature_id` text NOT NULL,
	`qty` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppe_collective_lines_collective_idx` ON `ppe_collective_lines` (`collective_id`);

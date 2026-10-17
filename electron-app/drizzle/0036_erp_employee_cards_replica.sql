-- Реплика erp_employee_cards: карточка сотрудника вошла в sync-контракт зеркалом
-- (PR-6, server-write / pull-only). Таблица живёт в реплике с drizzle 0006, но БЕЗ
-- sync-хвоста; хвост добавляют `ensureClientSchemaParity` (migrate.ts) и android-мигратор
-- на свежих и долгоживущих БД одинаково. Здесь записана итоговая форма таблицы.
-- Nullability — ровно как серверная erp_employee_cards (миграция 0111), иначе
-- checkReplicaStrictness уронит pull. Даты — integer (Unix-ms).
-- attrs_json в зеркало не едет (PII на сервере), но колонка в реплике есть с 0006 —
-- форма её сохраняет, чтобы parity-путь и записи не разъезжались.

CREATE TABLE `erp_employee_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`personnel_no` text,
	`full_name` text NOT NULL,
	`role_code` text,
	`attrs_json` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`last_server_seq` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `erp_employee_cards_personnel_no_uq` ON `erp_employee_cards` (`personnel_no`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `erp_employee_cards_full_name_idx` ON `erp_employee_cards` (`full_name`);

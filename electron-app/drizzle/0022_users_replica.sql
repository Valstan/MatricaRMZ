-- B3/R3 — реплика аккаунтов и доступов по разделам.
--
-- Это ЦЕПОЧКА №1 из двух: путь свежей установки (drizzle гонит файлы по
-- собственному журналу `__drizzle_migrations` независимо от ClientSchemaVersion).
-- Тот же DDL продублирован в `ensureClientSchemaParity` (migrate.ts) — это
-- страховка обоих путей. Версионную цепочку (clientSchemaMigrations) НЕ трогаем:
-- чистое добавление таблиц она не требует, а лишний бамп версии рискует уронить
-- часть парка в `rebuild` со сносом локальной базы (прецедент 2c597b8 обошёлся
-- ровно этими двумя записями).
--
-- IF NOT EXISTS обязателен: файл гоняется в одной транзакции, и «table already
-- exists» откатил бы её целиком, а self-heal в index.ts на такой откат СНОСИТ
-- базу пользователя вместе с неотправленной работой.

CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`system_role` text NOT NULL,
	`access_enabled` integer DEFAULT false NOT NULL,
	`delete_requested_at` integer,
	`delete_requested_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
-- Частичный, как на сервере: логин освобождается при отзыве аккаунта. Глобальный
-- unique заставил бы ремонт реплики снести отозванного, делящего логин с живым.
CREATE UNIQUE INDEX IF NOT EXISTS `users_login_live_uq` ON `users` (`login`) WHERE `deleted_at` is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `users_role_idx` ON `users` (`system_role`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `user_section_access` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`section_id` text NOT NULL,
	`level` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_section_access_pair_uq` ON `user_section_access` (`user_id`,`section_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_section_access_user_idx` ON `user_section_access` (`user_id`);

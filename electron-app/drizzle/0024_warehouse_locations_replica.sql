-- Реплика справочника складов и цехов (pull-only, план Б от 07.09.2026).
--
-- Зачем: разрез отчётов «по цехам» и подписи складов строятся по типу локации, а справочник жил
-- только на сервере и запрашивался по сети — без связи клиент не мог отличить цех от склада
-- (GOTCHAS M112). Таблица крошечная (15 строк) и меняется раз в год.
--
-- ЦЕПОЧКА №1 из двух (свежая установка идёт по журналу drizzle); тот же DDL продублирован
-- в `ensureClientSchemaParity` (migrate.ts). Версионную цепочку clientSchemaMigrations НЕ
-- бампаем — чистое добавление таблицы её не требует, а лишний бамп рискует уронить часть
-- парка в `rebuild` (прецедент 0022).
--
-- IF NOT EXISTS обязателен: файл гоняется в одной транзакции, «table already exists»
-- откатил бы её целиком, а self-heal снёс бы базу пользователя вместе с неотправленной работой.
-- Реплика не строже сервера (0020): CHECK-ограничение по `type` и unique по `code` не повторяем —
-- сервер их держит сам, а строгая реплика роняет pull всему парку.

CREATE TABLE IF NOT EXISTS `warehouse_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`workshop_id` text,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `warehouse_locations_type_idx` ON `warehouse_locations` (`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `warehouse_locations_code_idx` ON `warehouse_locations` (`code`);

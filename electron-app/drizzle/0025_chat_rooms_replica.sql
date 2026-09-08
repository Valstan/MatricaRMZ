-- Реплика комнат чата (владелец 08.09.2026). Комната — переписка группы: создатель набирает
-- в неё сотрудников, кто не приглашён — не получает ни строку комнаты, ни её сообщения
-- (фильтр выдачи на сервере, syncPrivacy).
--
-- ЦЕПОЧКА №1 из двух (свежая установка идёт по журналу drizzle); тот же DDL продублирован
-- в `ensureClientSchemaParity` (migrate.ts). Версионную цепочку clientSchemaMigrations НЕ
-- бампаем — добавление таблицы и nullable-колонки её не требует, а лишний бамп рискует
-- уронить часть парка в `rebuild` (прецедент 0022).
--
-- IF NOT EXISTS обязателен: файл гоняется в одной транзакции, «table already exists» откатил бы
-- её целиком, а self-heal снёс бы базу пользователя вместе с неотправленной работой.
-- Реплика не строже сервера: FOREIGN KEY и NOT NULL на members_json не повторяем.

CREATE TABLE IF NOT EXISTS `chat_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`title` text NOT NULL,
	`members_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_rooms_sync_status_idx` ON `chat_rooms` (`sync_status`);
--> statement-breakpoint
-- Адрес сообщения комнаты. IF NOT EXISTS для колонки SQLite не поддерживает, поэтому в
-- `ensureClientSchemaParity` тот же ALTER стоит под проверкой наличия колонки; здесь файл
-- журнала применяется ровно один раз, повтора не будет.
ALTER TABLE `chat_messages` ADD `room_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_messages_room_idx` ON `chat_messages` (`room_id`);

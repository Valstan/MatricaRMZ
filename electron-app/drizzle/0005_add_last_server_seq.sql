CREATE TABLE IF NOT EXISTS `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_user_id` text NOT NULL,
	`sender_username` text NOT NULL,
	`recipient_user_id` text,
	`message_type` text NOT NULL,
	`body_text` text,
	`payload_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_messages_sync_status_idx` ON `chat_messages` (`sync_status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `chat_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`read_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `chat_reads_message_user_uq` ON `chat_reads` (`message_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_reads_sync_status_idx` ON `chat_reads` (`sync_status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_presence` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_presence_user_id_uq` ON `user_presence` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_presence_sync_status_idx` ON `user_presence` (`sync_status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`title` text NOT NULL,
	`body_json` text,
	`importance` text DEFAULT 'normal' NOT NULL,
	`due_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notes_owner_sort_idx` ON `notes` (`owner_user_id`,`sort_order`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notes_sync_status_idx` ON `notes` (`sync_status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `note_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `note_shares_note_recipient_uq` ON `note_shares` (`note_id`,`recipient_user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `note_shares_recipient_sort_idx` ON `note_shares` (`recipient_user_id`,`sort_order`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `note_shares_sync_status_idx` ON `note_shares` (`sync_status`);
--> statement-breakpoint
ALTER TABLE entity_types ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE entities ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE attribute_defs ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE attribute_values ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE operations ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE chat_messages ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE chat_reads ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE notes ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE note_shares ADD COLUMN last_server_seq integer;
--> statement-breakpoint
ALTER TABLE user_presence ADD COLUMN last_server_seq integer;

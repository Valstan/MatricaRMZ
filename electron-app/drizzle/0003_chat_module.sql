CREATE TABLE `chat_messages` (
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
CREATE INDEX `chat_messages_sync_status_idx` ON `chat_messages` (`sync_status`);
--> statement-breakpoint
CREATE TABLE `chat_reads` (
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
CREATE UNIQUE INDEX `chat_reads_message_user_uq` ON `chat_reads` (`message_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `chat_reads_sync_status_idx` ON `chat_reads` (`sync_status`);
--> statement-breakpoint
CREATE TABLE `user_presence` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_presence_user_id_uq` ON `user_presence` (`user_id`);
--> statement-breakpoint
CREATE INDEX `user_presence_sync_status_idx` ON `user_presence` (`sync_status`);
